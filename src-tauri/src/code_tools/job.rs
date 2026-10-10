//! A Windows Job object around each host command the agent runs (phase 11,
//! #396): the one-shot `run_command_capture` and background processes.
//!
//! Every process the command starts joins the job, so Stop and the timeout
//! end the whole tree, children that escaped `taskkill /T` included. The job
//! kills on close, so a Haruspex that dies takes its commands with it. The
//! memory limit (Settings → Code) is the job's own `JobMemoryLimit`; when a
//! process goes over it the job is terminated and the caller is told, as a
//! Linux scope's oom-kill is reported.
//!
//! Off Windows `Job::new` returns None and callers keep their process groups.

#[cfg(windows)]
pub use imp::Job;

#[cfg(not(windows))]
#[derive(Debug)]
pub struct Job;

#[cfg(not(windows))]
impl Job {
    pub fn new(_limit_bytes: Option<u64>) -> Option<Job> {
        None
    }
    pub fn assign(&self, _pid: u32) -> bool {
        false
    }
    pub fn terminate(&self) {}
    #[cfg(test)]
    pub fn alive(&self) -> bool {
        false
    }
    pub fn out_of_memory(&self) -> bool {
        false
    }
    pub fn release(&self) {}
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Weak};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::SystemServices::{
        JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO, JOB_OBJECT_MSG_JOB_MEMORY_LIMIT,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    use windows_sys::Win32::System::IO::{
        CreateIoCompletionPort, GetQueuedCompletionStatus, PostQueuedCompletionStatus, OVERLAPPED,
    };

    /// The exit code a job ended for its memory limit gets.
    const OOM_EXIT: u32 = 0xE000_0001;
    /// Completion key the job's messages carry; [`WAKE`] tells the watcher
    /// thread the job is gone.
    const KEY: usize = 1;
    const WAKE: usize = 2;

    /// A Job object. Closing it (drop) kills what is still in it, unless
    /// [`Job::release`] let them go.
    #[derive(Debug)]
    pub struct Job {
        job: Arc<Handle>,
        port: usize,
        limit: Option<u64>,
        oom: Arc<AtomicBool>,
    }

    /// The job's handle, closed when the last holder lets go: the watcher
    /// thread holds it only while it acts, so a dropped `Job` is closed (and
    /// its processes killed) at once. Raw handles are not Send; kept as an
    /// integer.
    #[derive(Debug)]
    struct Handle(usize);

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0 as HANDLE);
            }
        }
    }

    impl Job {
        fn raw(&self) -> HANDLE {
            self.job.0 as HANDLE
        }

        /// A kill-on-close job, under `limit_bytes` when given. None when
        /// Windows won't make one; the caller then falls back to `taskkill`.
        pub fn new(limit_bytes: Option<u64>) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    log::warn!("could not create a job object for a command");
                    return None;
                }
                if !set_limits(job, true, limit_bytes) {
                    log::warn!("could not set a command's job limits");
                    CloseHandle(job);
                    return None;
                }
                // The port hears the memory limit being hit, and the job
                // emptying; without it there is no memory limit, only the kill.
                let port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1);
                let oom = Arc::new(AtomicBool::new(false));
                let mut port_ok = false;
                if !port.is_null() {
                    let assoc = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
                        CompletionKey: KEY as *mut core::ffi::c_void,
                        CompletionPort: port,
                    };
                    port_ok = SetInformationJobObject(
                        job,
                        JobObjectAssociateCompletionPortInformation,
                        &assoc as *const _ as *const core::ffi::c_void,
                        std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
                    ) != 0;
                    if !port_ok {
                        CloseHandle(port);
                    }
                }
                let port = if port_ok { port as usize } else { 0 };
                let job = Arc::new(Handle(job as usize));
                if port != 0 {
                    watch(Arc::downgrade(&job), port, oom.clone());
                }
                Some(Job {
                    job,
                    port,
                    limit: limit_bytes,
                    oom,
                })
            }
        }

        /// Put `pid` in the job; what it starts from then on joins too.
        pub fn assign(&self, pid: u32) -> bool {
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return false;
                }
                let ok = AssignProcessToJobObject(self.raw(), process) != 0;
                CloseHandle(process);
                ok
            }
        }

        /// End every process in the job, now.
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.raw(), 1);
            }
        }

        /// Whether any process is left in the job.
        #[cfg(test)]
        pub fn alive(&self) -> bool {
            use windows_sys::Win32::System::JobObjects::{
                JobObjectBasicAccountingInformation, QueryInformationJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            };
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.raw(),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                );
                ok != 0 && info.ActiveProcesses > 0
            }
        }

        /// The job was ended for going over its memory limit.
        pub fn out_of_memory(&self) -> bool {
            self.oom.load(Ordering::SeqCst)
        }

        /// Let what is still running outlive the job's handle: a finished
        /// one-shot's detached children, as on unix, where they survive the
        /// command's shell. The memory limit stays.
        pub fn release(&self) {
            unsafe {
                set_limits(self.raw(), false, self.limit);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                if self.port != 0 {
                    // The watcher closes the port once it reads this.
                    PostQueuedCompletionStatus(self.port as HANDLE, 0, WAKE, std::ptr::null());
                }
            }
        }
    }

    unsafe fn set_limits(job: HANDLE, kill_on_close: bool, limit: Option<u64>) -> bool {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        if kill_on_close {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        if let Some(limit) = limit {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.JobMemoryLimit = limit as usize;
        }
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0
    }

    /// A thread that reads the job's messages: over the memory limit, it ends
    /// the job (Windows only fails the allocation, and a process that
    /// survives that keeps trying) and records why. It stops when the job
    /// empties or is dropped, and closes the port.
    fn watch(job: Weak<Handle>, port: usize, oom: Arc<AtomicBool>) {
        std::thread::spawn(move || unsafe {
            loop {
                let mut msg = 0u32;
                let mut key = 0usize;
                let mut ov: *mut OVERLAPPED = std::ptr::null_mut();
                let ok = GetQueuedCompletionStatus(
                    port as HANDLE,
                    &mut msg,
                    &mut key,
                    &mut ov,
                    u32::MAX,
                );
                if ok == 0 || key == WAKE {
                    break;
                }
                if key != KEY {
                    continue;
                }
                match msg {
                    JOB_OBJECT_MSG_JOB_MEMORY_LIMIT => {
                        oom.store(true, Ordering::SeqCst);
                        // Gone: its close has killed the processes already.
                        if let Some(job) = job.upgrade() {
                            TerminateJobObject(job.0 as HANDLE, OOM_EXIT);
                        }
                    }
                    // Empty, but a released job's leftovers may join later; it
                    // keeps listening until dropped.
                    JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO => {}
                    _ => {}
                }
            }
            CloseHandle(port as HANDLE);
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::time::{Duration, Instant};

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        fn powershell(script: &str) -> std::process::Command {
            let mut c = std::process::Command::new("powershell.exe");
            c.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ]);
            c.creation_flags(CREATE_NO_WINDOW);
            c
        }

        fn wait_until(mut f: impl FnMut() -> bool) -> bool {
            let deadline = Instant::now() + Duration::from_secs(20);
            while Instant::now() < deadline {
                if f() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            false
        }

        #[test]
        fn terminate_ends_a_child_and_what_it_started() {
            let job = Job::new(None).unwrap();
            // A grandchild that outlives its parent's tree: taskkill /T can't
            // find it once the parent has gone.
            let mut child = powershell(
                "Start-Process -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 60'; Start-Sleep 60",
            )
            .spawn()
            .unwrap();
            assert!(job.assign(child.id()));
            std::thread::sleep(Duration::from_secs(2));
            assert!(job.alive());
            job.terminate();
            let _ = child.wait();
            assert!(wait_until(|| !job.alive()), "the job still has processes");
        }

        #[test]
        fn going_over_the_memory_limit_ends_the_job_and_says_so() {
            let job = Job::new(Some(200 << 20)).unwrap();
            let mut child = powershell(
                "$l = [System.Collections.Generic.List[byte[]]]::new(); while ($true) { $l.Add([byte[]]::new(16MB)) }",
            )
            .spawn()
            .unwrap();
            assert!(job.assign(child.id()));
            let status = child.wait().unwrap();
            assert!(!status.success());
            assert!(
                wait_until(|| job.out_of_memory()),
                "no memory-limit message"
            );
        }

        #[test]
        fn release_lets_a_finished_commands_children_live() {
            let job = Job::new(None).unwrap();
            let mut child = powershell("Start-Sleep 30").spawn().unwrap();
            assert!(job.assign(child.id()));
            job.release();
            drop(job);
            std::thread::sleep(Duration::from_millis(500));
            assert!(
                child.try_wait().unwrap().is_none(),
                "the release didn't hold"
            );
            let _ = child.kill();
        }
    }
}
