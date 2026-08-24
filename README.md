# ChatGPT Work Mode Discord Poll Image Generation

A proof of concept in which ChatGPT Work checks a dedicated Discord channel, reads finalized native polls through its signed-in browser, generates one image from the winning direction, and posts the result back to Discord.

This repository deliberately starts with research and an approved design. The original Discord bot and Playwright relay remain separate in `kyl33r/discord-image-feedback-relay`.

## Documents

- [Feasibility research](docs/research/2026-08-24-discord-work-skills-feasibility.md)
- [First POC design](docs/superpowers/specs/2026-08-24-discord-work-skill-poc-design.md)

Implementation starts after the design review gate. The first version is limited to one path: finalized poll, winning direction, one generated image, and one confirmed Discord post without duplicates.
