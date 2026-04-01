---
title: 'Installing Ghostty Terminal Emulator'
date: 2026-04-01
permalink: /posts/2026/04/install-ghostty/
tags:
  - tools
  - terminal
  - macos
---

[Ghostty](https://ghostty.org) is a fast, feature-rich terminal emulator built by Mitchell Hashimoto. It combines native platform integration with modern GPU-accelerated rendering.

## Installation

On macOS, install Ghostty via Homebrew:

```bash
brew install ghostty
```

That's it. Launch Ghostty from Spotlight or run `ghostty` from your existing terminal.

## Why Ghostty?

- **Fast**: GPU-accelerated rendering with minimal latency
- **Native**: Built with platform-native UI on macOS and Linux
- **Feature-rich**: Supports splits, tabs, ligatures, true color, and more
- **Configurable**: Simple text-based config at `~/.config/ghostty/config`

## Basic Configuration

Create `~/.config/ghostty/config` to customize:

```
font-family = JetBrains Mono
font-size = 14
theme = dark:Dracula,light:GitHub Light
```

Ghostty picks up config changes automatically — no restart needed.
