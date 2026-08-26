---
name: discord-image-paste
description: Paste one verified image from the browser clipboard into an allowlisted Discord channel and confirm its visible attachment before sending. Use when a Discord base image or generated result image must be attached through clipboard paste rather than the upload control.
---

# Discord Image Paste

Attach exactly one caller-approved image to an already prepared Discord message. The caller owns persisted round intent, the exact caption, destination validation, and the final confirmation command.

## Paste contract

1. Use the controlled signed-in Discord browser tab. Require its canonical channel URL to equal the caller's allowlisted channel. Never access Discord credentials or internal APIs.
2. Require the caller to persist intent before this skill runs. Obtain action-time confirmation unless the owner explicitly requested this exact live upload in the current turn.
3. Read the approved local PNG, JPEG, or WebP without printing its path or bytes. Write one browser clipboard item with the browser adapter's camelCase schema:

   ```js
   await tab.clipboard.write([{
     presentationStyle: "attachment",
     entries: [{ mimeType: "image/png", base64 }]
   }]);
   ```

   Match `mimeType` to the verified file type. Never use the adapter's internal snake_case names `mime_type` or `presentation_style`.
4. Use Discord's documented **Focus Text Area** shortcut as the primary focus path: press `Tab` exactly once. Do not click the composer, use coordinates, or press `Tab` repeatedly. Verify through a read-only page check that the active element is the unique channel message composer: it has `role="textbox"`, `contenteditable="true"`, and an accessible label beginning with `Message `. Do not reject a correctly focused composer only because the browser adapter reports zero-sized geometry. If the active element cannot be verified, stop before pasting. If a temporary desktop viewport override was already applied by the caller, reset the override when the operation pauses or finishes.
5. With that verified active element still focused, press `Meta+V` once. Verify the visible attachment preview before entering the caller's exact caption through the already focused composer. Do not refocus with a mouse or geometry after the paste. Verify both the preview and caption before sending.
6. Press `Enter` exactly once. After `Enter`, never paste, fill, press `Enter`, or retry the post automatically—even if link extraction or confirmation times out.
7. Recover the posted message only from the visible matching Discord message container. Require one stable message identity in the allowlisted channel and return it to the caller without printing it.

If the destination, active element, composer, attachment preview, send result, or message identity is uncertain, stop and let the caller persist `mark-attention`. Never substitute the upload control, another channel, another image, another caption, coordinate-based focus, or repeated focus shortcuts.
