---
title: Uploading to YouTube
description: Signing in to YouTube for uploads, what the upload dialog asks, visibility and made for kids, chapters and thumbnails, and following an upload.
---

# Uploading to YouTube

The assistant can upload an episode's render to your channel. It never uploads anything you haven't confirmed in a dialog first. Making the render is on the `video-render` page.

## Sign in to YouTube

Open Settings → Video → **YouTube** and click **Sign in to YouTube**. Your browser opens Google's consent screen; allow uploading. Haruspex asks Google only to upload videos: it can't read, change or delete your videos, playlists or comments. The card then shows the account. **Sign out** removes the permission from Google too.

This is separate from the Google sign-in for calendars in Settings → Integrations; signing out of one leaves the other.

## Upload a video

Ask "upload ep012 to YouTube". The assistant proposes a title, description and tags; the upload dialog shows them with the file, its length and size, the thumbnail and the account it goes to.

- Edit the **Title**, **Description**, **Tags** and **Category** as you like.
- **Visibility** starts at **Private**. Pick **Unlisted** or **Public** if you mean to.
- **Made for kids?** has no default: YouTube asks every uploader, and **Upload** stays greyed out until you answer.
- **Cancel** sends nothing.

The newest render of the episode's project is uploaded unless you name another. If the episode has a chapters file (see the `video-speech` page), its chapters are added to the end of the description. If it has a thumbnail (`<project>.thumbnail.jpg`, see the `video-render` page), that is set too.

## Follow an upload

The upload runs in the background with a card showing how far it has got and **Cancel**. A dropped connection resumes where it stopped. When it finishes, the assistant tells you the link; the card has **Open on YouTube** and **Open in Studio**.

A channel that isn't allowed custom thumbnails yet gets the video without one, and the assistant says so. Verify the channel in YouTube Studio to set thumbnails.

## What it doesn't do

- It doesn't upload captions: add the SRT in YouTube Studio → Subtitles.
- It doesn't schedule a publish time or change a video after it is uploaded.
- It doesn't upload from a job or subtask, only in a conversation with you there.
- Until Google approves the upload permission for Haruspex, the sign-in shows an "unverified app" warning.
