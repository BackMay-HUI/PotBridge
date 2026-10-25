# PotBridge native protocol v1

Transport: Edge Native Messaging, stdin/stdout, 4-byte little-endian byte length followed by UTF-8 JSON. Maximum inbound frame 256 KiB; outbound 1 MiB. Stdout contains protocol frames only. EOF cancels work and closes the relay.

Requests: `{ "protocolVersion": 1, "requestId": "unique-id", "type": "hello" }`.
Responses: `{ "protocolVersion": 1, "requestId": "unique-id", "ok": true, "result": {} }` or `ok:false,error:{code,message,stage?,status?}`. Concurrent replies may arrive out of order. Events have `type` and `sessionId`, no `requestId`.

| Request | Payload / result |
| --- | --- |
| hello | Version, local config, configWarning and active session summaries. Trusted settings view only. |
| configure | `config:{playerPath,proxyMode,proxyUrl,ffprobePath}`. Paths must reference local `.exe` files. Network mode changes require no active sessions. |
| probe | `candidate`. Bounded real GET preflight; optional codec inspection. |
| play | `candidate`. Preflight, loopback relay and player launch; returns `session:{id,url,title}`, `probe`, `state:"sent"`. |
| updateSession | `sessionId,candidate`, restricted to original section/pageKey. Returns `requiresResend:true`; does not promise seamless playback recovery. |
| stop | Optional `sessionId`; omission stops all sessions. |
| diagnostics | Sanitized session counters/status, version and proxy mode. No local relay token/URL, title, path, signed URL or headers. |

Candidate fields: `url,format,source,sectionId,pageKey,pageUrl,title,headersByOrigin`. The browser additionally tracks `id,tabId,frameId,capturedAt`. `headersByOrigin` keys are exact scheme + host + port origins. Native transport accepts only Referer, Origin, User-Agent, Cookie; account Authorization is excluded. Header values reject control characters.

Events: `mediaRequested` means first request arrived; `sessionError` includes a fault; `refreshNeeded` is emitted at most once per cycani session on upstream 401/403; `sessionEnded` means relay stopped. A closed native connection invalidates all its local relay URLs. No protocol operation asserts successful audio/video decoding.

There is no HTTP control API. Loopback GET/HEAD only serve authenticated resource mappings, and cannot launch programs or alter config. Public upstream URLs are checked at entry, DNS resolution and redirects; explicit configured proxy endpoints may themselves be local.
