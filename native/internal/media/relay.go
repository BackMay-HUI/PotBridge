package media

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

type EventSink func(map[string]any)
type SessionInfo struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	AudioURL string `json:"audioUrl,omitempty"`
}
type Summary struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Format       string `json:"format"`
	State        string `json:"state"`
	Requests     int64  `json:"requests"`
	Bytes        int64  `json:"bytes"`
	CreatedAt    int64  `json:"createdAt"`
	LastActivity int64  `json:"lastActivity"`
	Error        *Fault `json:"error,omitempty"`
}
type session struct {
	mu           sync.Mutex
	candidate    Candidate
	info         SessionInfo
	resources    map[string]Resource
	dashOrigins  map[string]string
	windows      map[string]map[string]bool
	order        []string
	summary      Summary
	active       int
	refreshAsked bool
	ctx          context.Context
	cancel       context.CancelFunc
}
type Relay struct {
	mu       sync.Mutex
	client   *Client
	events   EventSink
	server   *http.Server
	baseURL  string
	sessions map[string]*session
	done     chan struct{}
	once     sync.Once
}

func NewRelay(client *Client, events EventSink) *Relay {
	return &Relay{client: client, events: events, sessions: map[string]*session{}, done: make(chan struct{})}
}
func (r *Relay) emit(event map[string]any) {
	if r.events != nil {
		r.events(event)
	}
}
func (r *Relay) Create(c Candidate) (SessionInfo, error) {
	if err := c.Validate(); err != nil {
		return SessionInfo{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.sessions) >= 4 {
		return SessionInfo{}, Failure("SESSION_LIMIT", "session", "最多同时保留 4 个中转，请先结束不需要的会话。")
	}
	if r.server == nil {
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return SessionInfo{}, Failure("LOCAL_LISTEN_FAILED", "session", "无法创建本地中转端口。")
		}
		r.baseURL = "http://" + listener.Addr().String()
		r.server = &http.Server{Handler: r, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 * 1024}
		go r.server.Serve(listener)
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case now := <-ticker.C:
					r.Expire(now)
				case <-r.done:
					return
				}
			}
		}()
	}
	token := make([]byte, 24)
	if _, err := rand.Read(token); err != nil {
		return SessionInfo{}, Failure("RANDOM_FAILED", "session", "无法创建安全会话。")
	}
	id := hex.EncodeToString(token)
	ctx, cancel := context.WithCancel(context.Background())
	now := time.Now().UnixMilli()
	s := &session{candidate: c, resources: map[string]Resource{}, ctx: ctx, cancel: cancel, summary: Summary{ID: id, Title: c.Title, Format: c.Format, State: "sent", CreatedAt: now, LastActivity: now}}
	s.info = SessionInfo{ID: id, Title: c.Title, URL: r.baseURL + "/s/" + id + "/root/media" + mediaSuffix(c.URL, c.Format)}
	s.resources["root"] = Resource{URL: c.URL, Kind: "root"}
	if c.Video != nil {
		s.info.URL = r.baseURL + "/s/" + id + "/root/media.mp4"
		s.info.AudioURL = r.baseURL + "/s/" + id + "/audio/media.mp4"
		s.resources["root"] = Resource{URL: c.URL, Kind: "video"}
		s.resources["audio"] = Resource{URL: c.Audio.URL, Kind: "audio-track"}
	}
	r.sessions[id] = s
	return s.info, nil
}
func mediaSuffix(raw, kind string) string {
	if kind == "dash" || kind == "dash-manifest" {
		return ".mpd"
	}
	if kind == "hls" || kind == "playlist" || kind == "audio" || kind == "subtitle" || kind == "iframe" {
		return ".m3u8"
	}
	u, err := url.Parse(raw)
	if err == nil {
		ext := strings.ToLower(path.Ext(u.Path))
		switch ext {
		case ".mp4", ".m4s", ".ts", ".aac", ".vtt", ".key", ".m3u8":
			return ext
		}
	}
	if kind == "mp4" {
		return ".mp4"
	}
	return ".bin"
}
func resourceID(resource Resource) string {
	digest := sha256.Sum256([]byte(resource.URL))
	return hex.EncodeToString(digest[:16])
}
func (r *Relay) resourceURL(s *session, resource Resource) string {
	return r.baseURL + "/s/" + s.info.ID + "/" + resourceID(resource) + "/media" + mediaSuffix(resource.URL, resource.Kind)
}
func playlistResource(resource Resource) bool {
	return resource.Kind == "playlist" || resource.Kind == "audio" || resource.Kind == "subtitle" || resource.Kind == "iframe"
}
func (r *Relay) registerPlaylist(s *session, owner string, children map[string]Resource, order []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Stage the latest window per playlist, retaining the union of active tracks.
	// Dropping an old live window must never invalidate another track's current one.
	windows := make(map[string]map[string]bool, len(s.windows)+1)
	for id, window := range s.windows {
		windows[id] = window
	}
	window := make(map[string]bool, len(children))
	for id := range children {
		window[id] = true
	}
	windows[owner] = window
	protected := make(map[string]bool)
	reachable := make(map[string]map[string]bool)
	queue := []string{"root", owner}
	visited := make(map[string]bool)
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if visited[id] {
			continue
		}
		visited[id] = true
		if id != "root" {
			protected[id] = true
		}
		if window, ok := windows[id]; ok {
			reachable[id] = window
			for child := range window {
				protected[child] = true
				if _, ok := windows[child]; ok {
					queue = append(queue, child)
				}
			}
		}
	}
	if len(protected) > maxPlaylistResources {
		return Failure("MANIFEST_RESOURCE_LIMIT", "playlist", "当前清单及子清单的资源数超过 8192 上限。")
	}
	s.windows = reachable
	for _, id := range order {
		if _, ok := s.resources[id]; !ok {
			s.order = append(s.order, id)
		}
		s.resources[id] = children[id]
	}
	retained := s.order[:0]
	for _, id := range s.order {
		if len(s.resources) > maxPlaylistResources+1 && !protected[id] {
			delete(s.resources, id)
		} else {
			retained = append(retained, id)
		}
	}
	s.order = retained
	return nil
}
func (r *Relay) Stop(id string) {
	r.mu.Lock()
	s := r.sessions[id]
	delete(r.sessions, id)
	r.mu.Unlock()
	if s != nil {
		s.cancel()
		r.emit(map[string]any{"type": "sessionEnded", "sessionId": id})
	}
}
func (r *Relay) Update(id string, c Candidate) (SessionInfo, error) {
	if err := c.Validate(); err != nil {
		return SessionInfo{}, err
	}
	r.mu.Lock()
	s := r.sessions[id]
	r.mu.Unlock()
	if s == nil {
		return SessionInfo{}, Failure("SESSION_GONE", "session", "中转会话已结束。")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.SectionID == "" || c.SectionID != s.candidate.SectionID || c.PageKey != s.candidate.PageKey {
		return SessionInfo{}, Failure("CONTENT_CHANGED", "session", "网页内容已变化，请重新选择视频。")
	}
	// Keep old resource mappings: clients may still hold an earlier media playlist.
	// They are not guessed or patched with new signatures; a failed old resource requires re-send.
	s.candidate = c
	s.resources["root"] = Resource{URL: c.URL, Kind: "root"}
	s.summary.LastActivity = time.Now().UnixMilli()
	s.summary.Error = nil
	return s.info, nil
}
func (r *Relay) Summaries() []Summary {
	r.mu.Lock()
	list := make([]*session, 0, len(r.sessions))
	for _, s := range r.sessions {
		list = append(list, s)
	}
	r.mu.Unlock()
	result := make([]Summary, 0, len(list))
	for _, s := range list {
		s.mu.Lock()
		result = append(result, s.summary)
		s.mu.Unlock()
	}
	return result
}
func (r *Relay) Expire(now time.Time) {
	r.mu.Lock()
	var expired []string
	for id, s := range r.sessions {
		s.mu.Lock()
		if s.active == 0 && now.Sub(time.UnixMilli(s.summary.LastActivity)) > 30*time.Minute {
			expired = append(expired, id)
		}
		s.mu.Unlock()
	}
	r.mu.Unlock()
	for _, id := range expired {
		r.Stop(id)
	}
}
func (r *Relay) Close() {
	r.once.Do(func() {
		close(r.done)
		r.mu.Lock()
		for _, s := range r.sessions {
			s.cancel()
		}
		r.sessions = map[string]*session{}
		server := r.server
		r.mu.Unlock()
		if server != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			server.Shutdown(ctx)
		}
	})
}
func (r *Relay) sessionFault(s *session, f *Fault) {
	s.mu.Lock()
	s.summary.Error = f
	s.summary.State = "error"
	refresh := f.Code == "UPSTREAM_AUTH" && !s.refreshAsked && s.candidate.Source == "cycani" && s.candidate.SectionID != ""
	if refresh {
		s.refreshAsked = true
	}
	id := s.info.ID
	s.mu.Unlock()
	r.emit(map[string]any{"type": "sessionError", "sessionId": id, "error": f})
	if refresh {
		r.emit(map[string]any{"type": "refreshNeeded", "sessionId": id})
	}
}
func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if req.Method != "GET" && req.Method != "HEAD" {
		w.WriteHeader(405)
		return
	}
	// Browser pages never need to fetch the local relay; PotPlayer sends no Origin.
	if req.Header.Get("Origin") != "" {
		w.WriteHeader(403)
		return
	}
	parts := strings.Split(strings.Trim(req.URL.Path, "/"), "/")
	dashPath := len(parts) >= 4 && parts[2] == "dash"
	if (len(parts) != 4 && !dashPath) || parts[0] != "s" {
		w.WriteHeader(404)
		return
	}
	r.mu.Lock()
	s := r.sessions[parts[1]]
	r.mu.Unlock()
	if s == nil {
		w.WriteHeader(410)
		return
	}
	s.mu.Lock()
	resource, ok := s.resources[parts[2]]
	if dashPath {
		resource, ok = dashRequestResource(s, req.URL)
	}
	c := s.candidate
	if ok {
		s.active++
		s.summary.Requests++
		s.summary.LastActivity = time.Now().UnixMilli()
		if s.summary.State == "sent" {
			s.summary.State = "requested"
		}
	}
	count := s.summary.Requests
	s.mu.Unlock()
	if !ok {
		w.WriteHeader(410)
		return
	}
	defer func() { s.mu.Lock(); s.active--; s.summary.LastActivity = time.Now().UnixMilli(); s.mu.Unlock() }()
	if count == 1 {
		r.emit(map[string]any{"type": "mediaRequested", "sessionId": s.info.ID})
	}
	ctx, cancel := context.WithCancel(req.Context())
	stop := context.AfterFunc(s.ctx, cancel)
	defer func() { stop(); cancel() }()
	playlist := playlistResource(resource) || (resource.Kind == "root" && c.Format == "hls")
	dash := resource.Kind == "dash-manifest" || (resource.Kind == "root" && c.Format == "dash" && c.Video == nil)
	extra := req.Header.Clone()
	method := req.Method
	if playlist || dash {
		extra.Del("Range")
		extra.Del("If-Range")
		method = "GET"
	}
	// Some Bilibili VOD CDNs reject otherwise valid requests without Range.
	// Probe already uses one, but a player's first GET/HEAD may omit it.
	fallbackRange := c.Source == "bilibili" && !c.Live && !playlist && !dash && (c.Video != nil || c.Format == "mp4" || c.Format == "flv") && extra.Get("Range") == ""
	if fallbackRange {
		extra.Set("Range", "bytes=0-")
	}
	res, err := r.client.Fetch(ctx, c, resource.URL, method, extra)
	if err != nil {
		f := AsFault(err)
		if req.Context().Err() == nil {
			r.sessionFault(s, f)
		}
		http.Error(w, f.Message, 502)
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 && res.StatusCode != 206 && res.StatusCode != 416 {
		f := HTTPFailure(res.StatusCode, resource.Kind)
		r.sessionFault(s, f)
		http.Error(w, f.Message, 502)
		return
	}
	if fallbackRange && res.StatusCode == http.StatusPartialContent && completeByteRange(res.Header.Get("Content-Range"), res.ContentLength) {
		// The client requested a whole file. Normalize only a proven complete
		// zero-based response; a CDN-capped partial range must remain partial.
		res.StatusCode = http.StatusOK
		res.Header.Del("Content-Range")
	}
	for _, name := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if value := res.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	if resource.Kind == "dash-clock" && res.Header.Get("Date") != "" {
		w.Header().Set("Date", res.Header.Get("Date"))
	}
	if res.StatusCode == 416 {
		w.WriteHeader(416)
		return
	}
	if dash {
		r.serveDASH(w, req, s, res)
		return
	}
	if playlist {
		w.Header().Del("Content-Length")
		w.Header().Del("Content-Range")
		body, e := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024+1))
		if e != nil {
			r.sessionFault(s, Failure("READ_FAILED", "playlist", "播放清单读取失败。"))
			http.Error(w, "播放清单读取失败", 502)
			return
		}
		children := make(map[string]Resource)
		var order []string
		rewritten, e := RewritePlaylist(body, res.Request.URL.String(), func(child Resource) string {
			id := resourceID(child)
			if _, ok := children[id]; !ok {
				order = append(order, id)
			}
			children[id] = child
			return r.resourceURL(s, child)
		})
		if e == nil {
			e = r.registerPlaylist(s, parts[2], children, order)
		}
		if e != nil {
			r.sessionFault(s, AsFault(e))
			w.Header().Del("Content-Length")
			http.Error(w, AsFault(e).Message, 502)
			return
		}
		w.Header().Del("Content-Length")
		w.Header().Del("Content-Range")
		w.Header().Del("ETag")
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.WriteHeader(200)
		if req.Method != "HEAD" {
			n, _ := w.Write(rewritten)
			s.mu.Lock()
			s.summary.Bytes += int64(n)
			s.mu.Unlock()
		}
		return
	}
	if req.Method == "HEAD" {
		w.WriteHeader(res.StatusCode)
		return
	}
	reader := bufio.NewReader(res.Body)
	prefix, _ := reader.Peek(512)
	if looksLikeError(res.Header, prefix) {
		f := Failure("NOT_MEDIA", resource.Kind, "媒体资源返回了错误页面。")
		r.sessionFault(s, f)
		w.Header().Del("Content-Length")
		http.Error(w, f.Message, 502)
		return
	}
	w.WriteHeader(res.StatusCode)
	n, e := io.CopyBuffer(w, reader, make([]byte, 32*1024))
	s.mu.Lock()
	s.summary.Bytes += n
	s.mu.Unlock()
	if e != nil && req.Context().Err() == nil && s.ctx.Err() == nil {
		r.sessionFault(s, Failure("STREAM_INTERRUPTED", resource.Kind, "媒体传输中断，请检查网络后重试。"))
	}
}

func completeByteRange(value string, contentLength int64) bool {
	value, ok := strings.CutPrefix(value, "bytes 0-")
	if !ok {
		return false
	}
	end, total, ok := strings.Cut(value, "/")
	if !ok {
		return false
	}
	last, err := strconv.ParseUint(end, 10, 63)
	size, sizeErr := strconv.ParseUint(total, 10, 63)
	return err == nil && sizeErr == nil && size > 0 && last+1 == size && (contentLength < 0 || contentLength == int64(size))
}
