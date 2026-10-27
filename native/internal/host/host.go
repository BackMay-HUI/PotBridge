package host

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"potbridge/native/internal/media"
	"potbridge/native/internal/platform"
	"potbridge/native/internal/protocol"
	"sync"
)

const Version = "0.2.0"

type Request struct {
	ProtocolVersion int              `json:"protocolVersion"`
	RequestID       string           `json:"requestId"`
	Type            string           `json:"type"`
	Candidate       *media.Candidate `json:"candidate"`
	SessionID       string           `json:"sessionId"`
	OperationID     string           `json:"operationId"`
	Config          *platform.Config `json:"config"`
	operation       *playOperation
}
type Response struct {
	ProtocolVersion int          `json:"protocolVersion"`
	RequestID       string       `json:"requestId"`
	OK              bool         `json:"ok"`
	Result          any          `json:"result,omitempty"`
	Error           *media.Fault `json:"error,omitempty"`
}
type Host struct {
	mu          sync.Mutex
	config      platform.Config
	configPath  string
	configError error
	writer      *protocol.Writer
	client      *media.Client
	relay       *media.Relay
	operationMu sync.Mutex
	operations  map[string]*playOperation
	closed      bool
}

func New(configPath string, out io.Writer) *Host {
	config, err := platform.LoadConfig(configPath)
	if config.PlayerPath == "" {
		config.PlayerPath = platform.FindPlayer()
	}
	h := &Host{config: config, configPath: configPath, configError: err, writer: protocol.NewWriter(out), operations: make(map[string]*playOperation)}
	h.client = media.NewClient(func(req *http.Request) (*url.URL, error) {
		h.mu.Lock()
		c := h.config
		h.mu.Unlock()
		p, err := platform.ResolveProxy(req, c)
		if err != nil {
			return nil, media.Failure("PROXY_ERROR", "proxy", err.Error())
		}
		return p, nil
	})
	h.relay = media.NewRelay(h.client, func(event map[string]any) { event["protocolVersion"] = 2; h.writer.Send(event) })
	return h
}
func (h *Host) Close() {
	h.operationMu.Lock()
	h.closed = true
	for _, operation := range h.operations {
		operation.stopped = true
		operation.cancel()
	}
	h.operationMu.Unlock()
	h.relay.Close()
}
func (h *Host) Handle(ctx context.Context, body []byte) {
	h.prepare(ctx, body).run(false)
}
func (h *Host) prepare(ctx context.Context, body []byte) *preparedRequest {
	var req Request
	prepared := &preparedRequest{host: h, ctx: ctx, response: Response{ProtocolVersion: 2}}
	if err := json.Unmarshal(body, &req); err != nil {
		prepared.response.Error = media.Failure("INVALID_MESSAGE", "protocol", "消息不是有效 JSON。")
		return prepared
	}
	prepared.response.RequestID = req.RequestID
	if req.ProtocolVersion != 2 {
		prepared.response.Error = media.Failure("VERSION_MISMATCH", "protocol", "插件与本机组件的协议版本不一致，请重新安装同一版本。")
	} else if req.RequestID == "" || len(req.RequestID) > 128 {
		prepared.response.Error = media.Failure("INVALID_MESSAGE", "protocol", "请求标识无效。")
	} else if len(req.OperationID) > 128 || len(req.SessionID) > 128 {
		prepared.response.Error = media.Failure("INVALID_MESSAGE", "protocol", "播放操作或会话标识无效。")
	} else if req.Type == "play" {
		if req.OperationID == "" {
			req.OperationID = req.RequestID
		}
		operation, err := h.registerPlay(ctx, req.OperationID, req.SessionID)
		if err != nil {
			prepared.response.Error = media.AsFault(err)
		} else {
			req.operation = operation
			prepared.ctx = operation.ctx
		}
	}
	prepared.request = req
	return prepared
}
func (h *Host) dispatch(ctx context.Context, req Request) (any, error) {
	h.mu.Lock()
	cfg := h.config
	configErr := h.configError
	h.mu.Unlock()
	switch req.Type {
	case "hello":
		return map[string]any{"version": Version, "config": cfg, "configWarning": configErr != nil, "sessions": h.relay.Summaries()}, nil
	case "configure":
		if req.Config == nil {
			return nil, media.Failure("INVALID_CONFIG", "config", "缺少设置内容。")
		}
		if len(h.relay.Summaries()) > 0 && (req.Config.ProxyMode != cfg.ProxyMode || req.Config.ProxyURL != cfg.ProxyURL) {
			return nil, media.Failure("SESSIONS_ACTIVE", "config", "请先结束中转，再更改网络连接方式。")
		}
		if err := platform.SaveConfig(h.configPath, *req.Config); err != nil {
			return nil, media.Failure("INVALID_CONFIG", "config", err.Error())
		}
		h.mu.Lock()
		h.config = *req.Config
		h.configError = nil
		h.mu.Unlock()
		return req.Config, nil
	case "probe", "play", "updateSession":
		if req.Candidate == nil {
			return nil, media.Failure("NO_MEDIA", "input", "未提供媒体地址，请先在网页播放并重新检测。")
		}
		if req.Type == "play" && cfg.PlayerPath == "" {
			return nil, media.Failure("PLAYER_NOT_FOUND", "player", "请先在插件设置中选择 PotPlayer 可执行文件。")
		}
		result, err := h.client.Probe(ctx, *req.Candidate)
		if err != nil {
			if req.operation != nil && ctx.Err() != nil {
				return nil, playCancelled()
			}
			return nil, err
		}
		candidate := *req.Candidate
		if result.Resolved != nil {
			candidate = *result.Resolved
		}
		candidate.Format = result.Format
		if req.Type == "probe" {
			answer := map[string]any{"probe": result}
			if cfg.FFprobePath != "" {
				temporary := media.NewRelay(h.client, nil)
				defer temporary.Close()
				session, e := temporary.Create(candidate)
				if e == nil {
					codecs, e := platform.ProbeCodecs(ctx, cfg.FFprobePath, session.URL)
					if e != nil {
						answer["codecWarning"] = e.Error()
					} else {
						answer["codecs"] = codecs
					}
				}
			}
			return answer, nil
		}
		if req.Type == "updateSession" {
			session, e := h.relay.Update(req.SessionID, candidate)
			return map[string]any{"session": session, "probe": result, "requiresResend": true}, e
		}
		// Stop and session publication share this lock. A cancellation that has
		// completed can never be followed by a new relay or player launch.
		h.operationMu.Lock()
		defer h.operationMu.Unlock()
		if h.closed || req.operation == nil || req.operation.stopped || ctx.Err() != nil {
			return nil, playCancelled()
		}
		session, err := h.relay.Create(candidate)
		if err != nil {
			return nil, err
		}
		if err = platform.LaunchPlayerWithAudio(cfg.PlayerPath, session.URL, session.AudioURL); err != nil {
			h.relay.Stop(session.ID)
			return nil, media.Failure("PLAYER_LAUNCH_FAILED", "player", err.Error())
		}
		req.operation.sessionID = session.ID
		return map[string]any{"session": session, "probe": result, "state": "sent"}, nil
	case "stop":
		h.stop(req.OperationID, req.SessionID)
		return map[string]any{"stopped": true}, nil
	case "diagnostics":
		sessions := []map[string]any{}
		for _, s := range h.relay.Summaries() {
			sessions = append(sessions, map[string]any{"format": s.Format, "state": s.State, "requests": s.Requests, "bytes": s.Bytes, "createdAt": s.CreatedAt, "lastActivity": s.LastActivity, "error": s.Error})
		}
		return map[string]any{"version": Version, "proxyMode": cfg.ProxyMode, "playerConfigured": cfg.PlayerPath != "", "ffprobeConfigured": cfg.FFprobePath != "", "sessions": sessions}, nil
	default:
		return nil, media.Failure("UNKNOWN_COMMAND", "protocol", "本机组件不支持此操作。")
	}
}
