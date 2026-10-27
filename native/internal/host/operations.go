package host

import (
	"context"
	"io"
	"potbridge/native/internal/media"
	"potbridge/native/internal/protocol"
	"sync"
)

const maxWork = 8

type playOperation struct {
	ctx             context.Context
	cancel          context.CancelFunc
	previousSession string
	sessionID       string
	running         bool
	stopped         bool
}

type preparedRequest struct {
	host     *Host
	ctx      context.Context
	request  Request
	response Response
	once     sync.Once
}

func playCancelled() *media.Fault {
	return media.Failure("PLAY_CANCELLED", "play", "已取消本次播放并结束中转。")
}

// Serve registers a play in input order before scheduling its preflight. Stop
// runs synchronously and never waits for a network-work slot. Excess work is
// rejected, rather than blocking the reader that must receive cancellation.
func (h *Host) Serve(parent context.Context, input io.Reader) error {
	ctx, cancel := context.WithCancel(parent)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	slots := make(chan struct{}, maxWork)
	for {
		body, err := protocol.Read(input)
		if err != nil {
			return err
		}
		prepared := h.prepare(ctx, body)
		if prepared.response.Error != nil || prepared.request.Type == "stop" {
			prepared.run(false)
			continue
		}
		select {
		case slots <- struct{}{}:
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() { <-slots }()
				prepared.run(false)
			}()
		default:
			prepared.run(true)
		}
	}
}

func (p *preparedRequest) run(busy bool) {
	p.once.Do(func() {
		if p.request.operation != nil {
			defer p.host.finishPlay(p.request.OperationID, p.request.operation)
		}
		if busy && p.response.Error == nil {
			p.response.Error = media.Failure("BUSY", "protocol", "正在处理其他请求，请稍后重试。")
		}
		if p.response.Error == nil {
			result, err := p.host.dispatch(p.ctx, p.request)
			if err != nil {
				p.response.Error = media.AsFault(err)
			} else {
				p.response.OK, p.response.Result = true, result
			}
		}
		p.host.writer.Send(p.response)
	})
}

func (h *Host) registerPlay(ctx context.Context, id, previous string) (*playOperation, error) {
	h.operationMu.Lock()
	defer h.operationMu.Unlock()
	if h.closed {
		return nil, playCancelled()
	}
	// Retain a finished operation while its session exists: Stop may arrive
	// after publication but before the browser has received that session ID.
	active := make(map[string]bool)
	for _, session := range h.relay.Summaries() {
		active[session.ID] = true
	}
	pending := 0
	for key, operation := range h.operations {
		if !operation.running && !active[operation.sessionID] {
			delete(h.operations, key)
		} else if operation.running {
			pending++
		}
	}
	if h.operations[id] != nil {
		return nil, media.Failure("DUPLICATE_OPERATION", "protocol", "播放操作标识已在使用中。")
	}
	if pending >= maxWork {
		return nil, media.Failure("BUSY", "protocol", "正在处理其他播放请求，请稍后重试。")
	}
	ctx, cancel := context.WithCancel(ctx)
	operation := &playOperation{ctx: ctx, cancel: cancel, previousSession: previous, running: true}
	h.operations[id] = operation
	return operation, nil
}

func (h *Host) finishPlay(id string, operation *playOperation) {
	h.operationMu.Lock()
	defer h.operationMu.Unlock()
	operation.running = false
	operation.cancel()
	if operation.sessionID == "" || operation.stopped {
		if h.operations[id] == operation {
			delete(h.operations, id)
		}
	}
}

func (h *Host) stop(operationID, sessionID string) {
	h.operationMu.Lock()
	defer h.operationMu.Unlock()
	all := operationID == "" && sessionID == ""
	for id, operation := range h.operations {
		pendingReplacement := operation.running && operation.sessionID == "" && operation.previousSession == sessionID
		if all || id == operationID || (sessionID != "" && (operation.sessionID == sessionID || pendingReplacement)) {
			operation.stopped = true
			operation.cancel()
			if operation.sessionID != "" {
				h.relay.Stop(operation.sessionID)
			}
			if !operation.running {
				delete(h.operations, id)
			}
		}
	}
	if all {
		for _, session := range h.relay.Summaries() {
			h.relay.Stop(session.ID)
		}
	} else if sessionID != "" {
		h.relay.Stop(sessionID)
	}
}
