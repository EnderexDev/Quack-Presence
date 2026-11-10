# Changelog

All notable changes to Quack Presence are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each version is a tag and a GitHub
release of this repo; its section here is that release's notes. A change a user notices adds its
line under [Unreleased], and `npm run release` turns that section into the version.

## [Unreleased]

## [1.1.2] - 2026-11-05

### Fixed
- The installer no longer closes in the middle of the install, and reopens Quack Presence if the install fails.

## [1.1.1] - 2026-11-05

### Fixed
- The installer closes only the running Quack Presence, never another Node process, and reopens it if the install fails.

### Changed
- Quack Presence needs Node 22.13 or newer (`node:sqlite` without a flag).

## [1.1.0] - 2026-11-05

### Added
- Its own installer and automatic updates from GitHub, with an Update button in the tray panel.

[Unreleased]: https://github.com/EnderexDev/Quack-Presence/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/EnderexDev/Quack-Presence/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/EnderexDev/Quack-Presence/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/EnderexDev/Quack-Presence/releases/tag/v1.1.0
