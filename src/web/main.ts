/**
 * The web client: the owner's Code sessions, from another device, through the
 * owner API (plan/remote-api phase 4). Turns run on the desktop; this page
 * follows them and sends what the owner types.
 */
import { mount } from 'svelte';
import '#lib/styles/app.css';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
