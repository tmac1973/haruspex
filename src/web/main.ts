/**
 * The web client: the owner's Code sessions, from another device, through the
 * owner API (plan/remote-api phase 4). Turns run on the desktop; this page
 * follows them and sends what the owner types.
 */
import { mount } from 'svelte';
import '#lib/styles/app.css';
import { installMarkdownActions } from '#lib/markdown-actions.ts';
import { installAudioExclusivity } from '#lib/audio/exclusive.ts';
import App from './App.svelte';

// Code blocks' Copy buttons (rendered markdown can't carry handlers).
installMarkdownActions();
// One generated-audio player at a time.
installAudioExclusivity(document);
mount(App, { target: document.getElementById('app')! });
