# PotBridge v0.3.0 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation and one independent final review.

**Goal:** Ship the five designed themes in the real Edge extension, package v0.3.0 and publish it to the existing public GitHub repository.

**Architecture:** Keep native DOM/TypeScript/Vite and Native Messaging protocol 2. Apply semantic CSS tokens to the existing operations; keep appearance storage separate from host configuration and site permissions. Use an early local cache followed by authoritative chrome.storage.local and onChanged synchronization.

**Tech Stack:** TypeScript, HTML/CSS, Vite, Node test runner/happy-dom, existing Go native host.

**Spec:** docs/superpowers/specs/2026-10-27-potbridge-v03-design.md. User explicitly requested formal v0.3 implementation and release on 2026-10-28; the previous design-only gate is now satisfied by that instruction.

## Global Constraints

- Exactly five themes: luna / porcelain / reload / mica / forest; default luna.
- Shared operation layout, explicit Luna portrait in header; 560 × 600 CSS px popup.
- All fonts, scripts and images local; optimized portrait <= 400 KB; no new runtime dependencies or permissions.
- Preserve MP4, HLS, Bilibili paired audio, DASH, FLV, diagnostics and stop operations; protocol remains 2, compatible with v0.2 host.
- Theme selection is immediate and automatic; host settings still require Save.
- Never claim decoded playback from a successful send or request.
- Publish source, README, release notes, Windows x64 ZIP and SHA256 to BackMay-HUI/PotBridge; repository stays public; preserve older releases.

## Review Focus

- A delayed initial read or overlapping writes must not undo a newer user selection.
- Invalid or unavailable storage must leave the UI and playback controls usable.
- Cross-page changes must preserve unsaved host fields, chosen source, focus and scroll.
- Long real titles, many sources and verbose errors must remain readable and reachable in the popup.
- Release HTML/CSS must resolve local portrait and early initialization under extension CSP.

---

### Task 1: Production theme persistence and controls

**Files:** Create extension/src/ui/theme.ts, extension/public/theme-init.js, tests/theme.test.ts.

**Interfaces:** Export initializeTheme(document, storage?) -> Promise<void>. Storage uses chrome.storage.local.get/set and chrome.storage.onChanged. Mount in #theme-menu / #theme-cards; theme inputs use quick-theme and settings-theme names. Only write appearance: {version:1, theme:ThemeId}. Update root data-theme, selected controls, #appearance-feedback and .theme-footer-name without replacing user content.

- [ ] Write failing behavioral tests for validation/default, startup cache reconciliation, delayed reads, serialized rapid selection, synchronization, Escape/focus, storage failure and preservation of unrelated config/source DOM.
- [ ] Run node --test tests/theme.test.ts. Expected: fails because production theme implementation is missing.
- [ ] Implement the controller and local early script. No inline script or remote request.
- [ ] Run node --test tests/theme.test.ts and npm run typecheck. Expected: all pass.
- [ ] Commit the independently testable theme controller.

### Task 2: Integrate real popup and settings

**Files:** Modify extension/popup.html, options.html, src/ui/popup.ts, options.ts, view.ts, styles.css. Add src/ui/themes.css, src/ui/assets/luna-portrait.webp and tests/ui-pages.test.ts. Adapt approved CSS into production; do not import demo actions.

**Interfaces:** Consume initializeTheme(document), preserve every existing action DOM ID and RPC payload. Source rendering adds designed title/meta classes. Settings form excludes theme radios; independent theme feedback does not overwrite host save feedback. Keep backend calls from api.ts.

- [ ] Add real-page harness tests that run existing popup/options controller code against real HTML with only browser/host boundaries faked. Cover selection/play/stop, theme switching while busy, unsaved configuration, save, export and cross-page synchronization.
- [ ] Run node --test tests/ui-pages.test.ts. Expected: theme controls/assertions fail on old production HTML.
- [ ] Integrate the designed markup, tokens, portrait and controls with real RPCs; support native radio keyboard behavior and one popup scroll area.
- [ ] Run npm test, npm run typecheck and npm run build. Expected: pass and local assets emitted.
- [ ] Inspect real production pages in browser for all themes, keyboard focus, unavailable states, long content and responsive settings. Check built HTML/CSP/portrait paths.
- [ ] Commit integrated UI and tests.

### Task 3: Version, verify, review and publish

**Files:** Update package.json/package-lock.json, manifest, native host version, release docs, README, CHANGELOG, acceptance/release-check. Expand scripts/verify-package.mjs to follow HTML/CSS assets and verify local early script.

**Interfaces:** Consume production UI and build outputs. Version 0.3.0, protocol 2. Native host branding version may change but protocol compatibility remains with v0.2.

- [ ] Update release metadata and truthful upgrade instructions; from v0.2 only replace extension contents in the same directory, reload and refresh media pages; no host reinstall needed for themes.
- [ ] Run npm test, npm run typecheck, Go test/vet, npm run build, npm run package, npm run verify:package. Expected: all pass; ZIP and checksum generated.
- [ ] Request one fresh-context code review; fix important findings with regression tests and rerun relevant checks.
- [ ] Commit final version and docs; publish exact source to main with expected-head guard, tag v0.3.0, create release and upload ZIP/SHA256.
- [ ] Read remote repository visibility, main/tag commit and asset sizes/digests; compare old release digests. Expected: public, exact new commit/assets, older releases unchanged.
- [ ] Audit all requirements, report download/upgrade instructions and mark goal complete only after remote verification.
