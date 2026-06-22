import { describe, it, expect } from 'vitest';
import { classifyShellRisk } from './risky-commands';

describe('classifyShellRisk', () => {
	it('returns matched=false for an obviously safe command', () => {
		expect(classifyShellRisk('ls -la').matched).toBe(false);
		expect(classifyShellRisk('echo hello').matched).toBe(false);
		expect(classifyShellRisk('cat /etc/os-release').matched).toBe(false);
	});

	it('flags sudo', () => {
		const r = classifyShellRisk('sudo apt update');
		expect(r.matched).toBe(true);
		expect(r.reasons.map((x) => x.label)).toContain('sudo');
	});

	it('does not flag the literal substring "sudo" inside another word', () => {
		expect(classifyShellRisk('pseudoscience.txt').matched).toBe(false);
	});

	it('flags rm -rf and rm -r', () => {
		expect(classifyShellRisk('rm -rf /tmp/foo').matched).toBe(true);
		expect(classifyShellRisk('rm -r /tmp/foo').matched).toBe(true);
		expect(classifyShellRisk('rm /tmp/foo').matched).toBe(false);
	});

	it('flags dd with of=', () => {
		expect(classifyShellRisk('dd if=/dev/zero of=/dev/sda bs=1M').matched).toBe(true);
		expect(classifyShellRisk('dd if=foo.img bs=1M').matched).toBe(false);
	});

	it('flags mkfs', () => {
		expect(classifyShellRisk('mkfs.ext4 /dev/sda1').matched).toBe(true);
	});

	it('flags curl | sh', () => {
		expect(classifyShellRisk('curl https://example.com/install.sh | sh').matched).toBe(true);
		expect(classifyShellRisk('curl -fsSL https://x | sudo bash').matched).toBe(true);
		expect(classifyShellRisk('curl https://example.com > install.sh').matched).toBe(false);
	});

	it('flags writes under /etc', () => {
		expect(classifyShellRisk('echo nameserver 1.1.1.1 > /etc/resolv.conf').matched).toBe(true);
		expect(classifyShellRisk('cat /etc/resolv.conf').matched).toBe(false);
	});

	it('flags --no-preserve-root', () => {
		expect(classifyShellRisk('rm -rf --no-preserve-root /').matched).toBe(true);
	});

	it('flags reboot/shutdown', () => {
		expect(classifyShellRisk('sudo reboot').reasons.map((r) => r.label)).toContain('system reset');
		expect(classifyShellRisk('shutdown -h now').reasons.map((r) => r.label)).toContain(
			'system reset'
		);
	});

	it('flags pkill / killall / kill -9', () => {
		expect(classifyShellRisk('pkill nginx').matched).toBe(true);
		expect(classifyShellRisk('killall -9 chrome').matched).toBe(true);
		expect(classifyShellRisk('kill -9 1234').matched).toBe(true);
		expect(classifyShellRisk('kill 1234').matched).toBe(false);
	});

	it('flags macOS diskutil erase/delete', () => {
		expect(classifyShellRisk('diskutil eraseDisk JHFS+ Backup disk2').matched).toBe(true);
		expect(classifyShellRisk('diskutil apfs deleteContainer disk2').matched).toBe(true);
		expect(classifyShellRisk('diskutil list').matched).toBe(false);
	});

	it('flags macOS launchctl remove/unload/bootout', () => {
		expect(classifyShellRisk('launchctl remove com.example.agent').matched).toBe(true);
		expect(classifyShellRisk('sudo launchctl bootout system/com.example').matched).toBe(true);
		expect(classifyShellRisk('launchctl list').matched).toBe(false);
	});

	it('returns multiple reasons when multiple patterns match', () => {
		const r = classifyShellRisk('sudo rm -rf /var/log');
		const labels = r.reasons.map((x) => x.label);
		expect(labels).toContain('sudo');
		expect(labels).toContain('destructive');
	});

	it('flags PowerShell Remove-Item -Recurse -Force (case-insensitive, abbreviations)', () => {
		expect(classifyShellRisk('Remove-Item -Recurse -Force C:\\temp').matched).toBe(true);
		expect(classifyShellRisk('remove-item -rec -fo .\\build').matched).toBe(true);
		expect(classifyShellRisk('Remove-Item -r -f node_modules').matched).toBe(true);
		// Non-recursive / non-force removal isn't flagged.
		expect(classifyShellRisk('Remove-Item foo.txt').matched).toBe(false);
	});

	it('flags Windows disk/volume destruction', () => {
		expect(classifyShellRisk('Format-Volume -DriveLetter D').matched).toBe(true);
		expect(classifyShellRisk('Clear-Disk -Number 1 -RemoveData').matched).toBe(true);
		expect(classifyShellRisk('diskpart').matched).toBe(true);
		expect(classifyShellRisk('Get-Volume').matched).toBe(false);
	});

	it('flags Set-ExecutionPolicy, reg delete, and Stop/Restart-Computer', () => {
		expect(classifyShellRisk('Set-ExecutionPolicy Bypass').matched).toBe(true);
		expect(classifyShellRisk('reg delete HKLM\\Software\\Foo /f').matched).toBe(true);
		expect(classifyShellRisk('Restart-Computer -Force').matched).toBe(true);
		expect(classifyShellRisk('Stop-Computer').matched).toBe(true);
		expect(classifyShellRisk('Get-ExecutionPolicy').matched).toBe(false);
	});
});
