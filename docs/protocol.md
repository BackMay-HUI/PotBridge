# PotBridge native protocol v2 (v0.2.0)

Transport: Edge Native Messaging, stdin/stdout, 4-byte little-endian byte length followed by UTF-8 JSON. Maximum inbound frame 256 KiB; outbound 1 MiB. Stdout contains protocol frames only. EOF cancels work and closes the relay.

Requests: `{ "protocolVersion": 2, "requestId": "unique-id", "type": "hello" }`.
Responses: `{ "protocolVersion": 2, "requestId": "unique-id", "ok": true, "result": {} }` or `ok:false,error:{code,message,stage?,status?}`. Concurrent replies may arrive out of order. Events have `type` and `sessionId`, no `requestId`. Protocol 1 is rejected with VERSION_MISMATCH; the v0.2 extension recognizes old-host mismatch replies immediately.

| Request | Payload / result |
| --- | --- |
| hello | Version, local config, configWarning and active session summaries. Trusted settings view only. |
| configure | `config:{playerPath,proxyMode,proxyUrl,ffprobePath}`. Paths must reference local `.exe` files. Network mode changes require no active sessions. |
| probe | `candidate`. Bounded real GET preflight; optional codec inspection. |
| play | `candidate,operationId?,sessionId?`. Preflight, loopback relay and player launch; returns `session:{id,url,title,audioUrl?}`, `probe`, `state:"sent"`. For paired media, both URL and audioUrl are authenticated local relay URLs, opened through separate argv with `/aud=audioUrl`. operationId identifies cancellation (defaults to requestId); optional sessionId identifies the active session being replaced. |
| updateSession | `sessionId,candidate`, restricted to original section/pageKey. Returns `requiresResend:true`; does not promise seamless playback recovery. |
| stop | Optional `sessionId,operationId`; omission of both stops all sessions and pending plays. A session stop also cancels its pending replacement; an operation stop targets only that play and any session it has already published. |
| diagnostics | Sanitized session counters/status, version and proxy mode. No local relay token/URL, title, path, signed URL or headers. |

Candidate fields: `url,format,source,sectionId,pageKey,pageUrl,title,headersByOrigin`. The browser additionally tracks `id,tabId,frameId,capturedAt`. `headersByOrigin` keys are exact scheme + host + port origins. Native transport accepts only Referer, Origin, User-Agent, Cookie; account Authorization is excluded. Header values reject control characters.

v0.2 adds `video?,audio?,quality?,contentId?,live?`. Track fields are `url,backupUrls?,id?,mimeType?,codecs?,bandwidth?,width?,height?,frameRate?`; URLs are bounded HTTP/HTTPS values, backupUrls has at most two entries. A pair uses format dash and requires both tracks, with candidate.url equal to video.url. A generic MPD has format dash without video/audio fields. FLV uses format flv. Missing pair audio returns AUDIO_UNAVAILABLE. Probe checks both tracks, may choose an authorized backup, and does not expose its internal resolved candidate in JSON diagnostics.

Events: `mediaRequested` means first request arrived; `sessionError` includes a fault; `refreshNeeded` is emitted at most once per cycani session on upstream 401/403; `sessionEnded` means relay stopped. A closed native connection invalidates all its local relay URLs. No protocol operation asserts successful audio/video decoding.

There is no HTTP control API. Loopback GET/HEAD only serve authenticated resource mappings, and cannot launch programs or alter config. Public upstream URLs are checked at entry, DNS resolution and redirects; explicit configured proxy endpoints may themselves be local.

Play operations are registered in input order before concurrent preflight. At most eight background requests run concurrently; excess work returns BUSY. Stop and validation replies do not queue behind network work. A completed stop prevents canceled preflights from creating a new relay/player and returns PLAY_CANCELLED to that play request. The browser also stops any late returned session. An operation ID must be unique while pending or while its published session is active; IDs and session IDs are capped at 128 characters. Finished-operation bookkeeping is pruned with the bounded active sessions.

Established sessions survive source-tab navigation/closure and popup closure; pending sends are canceled on source-page changes. Explicit stop, native disconnect, host exit and expiry clean both paired tracks. No operation promises decoding or seamless playback recovery.
