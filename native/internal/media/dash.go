package media

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const dashNamespace = "urn:mpeg:dash:schema:mpd:2011"
const dashBodyLimit = 2 * 1024 * 1024

type dashNode struct {
	name     xml.Name
	attrs    []xml.Attr
	text     string
	children []*dashNode
}

func (n *dashNode) attr(key string) string {
	for _, a := range n.attrs {
		if a.Name.Space == "" && a.Name.Local == key {
			return a.Value
		}
	}
	return ""
}
func (n *dashNode) set(key, value string) {
	for i := range n.attrs {
		if n.attrs[i].Name.Space == "" && n.attrs[i].Name.Local == key {
			n.attrs[i].Value = value
			return
		}
	}
	n.attrs = append(n.attrs, xml.Attr{Name: xml.Name{Local: key}, Value: value})
}
func (n *dashNode) child(name string) *dashNode {
	for _, c := range n.children {
		if c.name.Local == name {
			return c
		}
	}
	return nil
}
func dashError(code, message string) error { return Failure(code, "manifest", message) }
func parseDASH(body []byte) (*dashNode, error) {
	if len(body) > dashBodyLimit {
		return nil, dashError("MANIFEST_TOO_LARGE", "DASH 清单超过 2 MiB 限制。")
	}
	d := xml.NewDecoder(bytes.NewReader(body))
	var root *dashNode
	var stack []*dashNode
	count := 0
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, dashError("INVALID_MPD", "DASH XML 格式无效。")
		}
		switch v := tok.(type) {
		case xml.Directive:
			return nil, dashError("UNSUPPORTED_XML", "不支持外部 XML、DTD 或实体声明。")
		case xml.ProcInst:
			if v.Target != "xml" {
				return nil, dashError("UNSUPPORTED_XML", "不支持 XML 处理指令。")
			}
		case xml.StartElement:
			count++
			if count > 50000 || len(stack) >= 64 {
				return nil, dashError("MANIFEST_LIMIT", "DASH XML 层数或元素数超过限制。")
			}
			if v.Name.Space != "" && v.Name.Space != dashNamespace {
				return nil, dashError("UNSUPPORTED_MPD", "不支持扩展命名空间的 DASH 元素。")
			}
			parent := ""
			if len(stack) > 0 {
				parent = stack[len(stack)-1].name.Local
			}
			allowed := map[string]string{
				"MPD": "|", "Period": "|MPD|", "AdaptationSet": "|Period|", "Representation": "|AdaptationSet|",
				"BaseURL":     "|MPD|Period|AdaptationSet|Representation|",
				"SegmentBase": "|Period|AdaptationSet|Representation|", "SegmentList": "|Period|AdaptationSet|Representation|", "SegmentTemplate": "|Period|AdaptationSet|Representation|",
				"SegmentTimeline": "|SegmentList|SegmentTemplate|", "S": "|SegmentTimeline|", "SegmentURL": "|SegmentList|",
				"Initialization": "|SegmentBase|SegmentList|SegmentTemplate|", "RepresentationIndex": "|SegmentBase|SegmentList|SegmentTemplate|", "BitstreamSwitching": "|SegmentList|SegmentTemplate|",
				"Location": "|MPD|", "UTCTiming": "|MPD|",
			}
			if parents, known := allowed[v.Name.Local]; known && !(parent == "" && v.Name.Local == "MPD") && !strings.Contains(parents, "|"+parent+"|") {
				return nil, dashError("INVALID_MPD", "DASH 元素位于无效层级。")
			}
			switch v.Name.Local {
			case "ContentProtection":
				return nil, dashError("DRM_UNSUPPORTED", "不支持带 ContentProtection 的 DRM 清单。")
			case "PatchLocation", "SubRepresentation":
				return nil, dashError("UNSUPPORTED_MPD", "暂不支持 MPD 补丁或 SubRepresentation。")
			}
			n := &dashNode{name: v.Name}
			for _, a := range v.Attr {
				if a.Name.Local == "xmlns" || a.Name.Space == "xmlns" {
					continue
				}
				if a.Name.Space == "http://www.w3.org/1999/xlink" || a.Name.Local == "href" || (a.Name.Space == "http://www.w3.org/XML/1998/namespace" && a.Name.Local == "base") {
					return nil, dashError("UNSUPPORTED_XML", "不支持外部 XML 引用或 xml:base。")
				}
				n.attrs = append(n.attrs, a)
			}
			if len(stack) == 0 {
				if root != nil || v.Name.Local != "MPD" {
					return nil, dashError("INVALID_MPD", "清单根元素必须是 MPD。")
				}
				root = n
			} else {
				p := stack[len(stack)-1]
				p.children = append(p.children, n)
			}
			stack = append(stack, n)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].text += string(v)
			} else if strings.TrimSpace(string(v)) != "" {
				return nil, dashError("INVALID_MPD", "MPD 外包含无效文本。")
			}
		}
	}
	if root == nil || len(stack) != 0 {
		return nil, dashError("INVALID_MPD", "DASH 清单为空或不完整。")
	}
	return root, nil
}
func cloneDASH(n *dashNode) *dashNode {
	if n == nil {
		return nil
	}
	c := &dashNode{name: n.name, attrs: append([]xml.Attr(nil), n.attrs...), text: n.text}
	for _, ch := range n.children {
		c.children = append(c.children, cloneDASH(ch))
	}
	return c
}
func inheritDASH(parent, own *dashNode) *dashNode {
	if own == nil {
		return cloneDASH(parent)
	}
	if parent == nil || parent.name.Local != own.name.Local {
		return cloneDASH(own)
	}
	n := cloneDASH(parent)
	for _, a := range own.attrs {
		n.set(a.Name.Local, a.Value)
	}
	for _, ch := range own.children {
		kept := n.children[:0]
		for _, old := range n.children {
			if old.name.Local != ch.name.Local {
				kept = append(kept, old)
			}
		}
		n.children = kept
	}
	for _, ch := range own.children {
		n.children = append(n.children, cloneDASH(ch))
	}
	return n
}

var dashToken = regexp.MustCompile(`\$(RepresentationID|Number|Bandwidth|Time)(%0[1-9][0-9]?d)?\$|\$\$`)

func maskDASH(raw string) (string, func(string) string, error) {
	masked, restore, err := maskDASHInputs(raw)
	if err != nil {
		return "", nil, err
	}
	return masked[0], restore, nil
}

// Resolved URLs have already validated their authored reference. Their inherited
// signing text is concrete URL data, not new template syntax to validate again.
// Keep masking known tokens for URL parsing and collision-safe restoration.
func maskResolvedDASH(raw string) (string, func(string) string, error) {
	masked, restore, err := maskDASHInputs(raw, "")
	if err != nil {
		return "", nil, err
	}
	return masked[0], restore, nil
}

func maskDASHInputs(inputs ...string) ([]string, func(string) string, error) {
	// URL parsing can decode literal path bytes. Exclude both the original and
	// decoded text from marker selection across every input being resolved.
	var literals []string
	for _, raw := range inputs {
		literals = append(literals, raw)
		withoutTokens := dashToken.ReplaceAllString(raw, "")
		if decoded, err := url.PathUnescape(withoutTokens); err == nil {
			literals = append(literals, decoded)
		}
	}
	prefix := "__PB_DASH_"
	for {
		collision := false
		for _, literal := range literals {
			if strings.Contains(literal, prefix) {
				collision = true
				break
			}
		}
		if !collision {
			break
		}
		prefix += "_"
	}
	var pairs []string
	bad := false
	masked := make([]string, len(inputs))
	for i, raw := range inputs {
		// Only the final input is a manifest-authored reference. Earlier inputs
		// are resolved base URLs, whose signing text may contain literal '$'.
		validateTemplate := i == len(inputs)-1
		masked[i] = dashToken.ReplaceAllStringFunc(raw, func(token string) string {
			if validateTemplate && strings.HasPrefix(token, "$RepresentationID%") {
				bad = true
			}
			key := fmt.Sprintf("%s%d__", prefix, len(pairs)/2)
			pairs = append(pairs, key, token)
			return key
		})
		if validateTemplate && strings.Contains(masked[i], "$") {
			bad = true
		}
	}
	if bad {
		return nil, nil, dashError("INVALID_TEMPLATE", "DASH 模板变量无效。")
	}
	return masked, strings.NewReplacer(pairs...).Replace, nil
}
func resolveDASH(base, raw string) (string, error) {
	masked, restore, err := maskDASHInputs(base, raw)
	if err != nil {
		return "", err
	}
	rel, err := url.Parse(masked[1])
	if err != nil {
		return "", dashError("INVALID_URL", "DASH 资源地址无效。")
	}
	b, err := url.Parse(masked[0])
	if err != nil {
		return "", dashError("INVALID_URL", "DASH 基础地址无效。")
	}
	u := b.ResolveReference(rel)
	if u.User != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || strings.Contains(u.Host, "__PB_DASH_") || u.Fragment != "" || len(raw) > 16384 || !safeDASHPath(u.EscapedPath()) {
		return "", dashError("INVALID_URL", "DASH 资源地址或模板来源无效。")
	}
	return restore(u.String()), nil
}
func dashRange(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	p := strings.Split(raw, "-")
	if len(p) != 2 {
		return "", dashError("INVALID_MPD", "DASH 字节范围无效。")
	}
	a, e := strconv.ParseUint(p[0], 10, 63)
	b, e2 := strconv.ParseUint(p[1], 10, 63)
	if e != nil || e2 != nil || b < a || b-a >= 1<<63-1 {
		return "", dashError("INVALID_MPD", "DASH 字节范围无效。")
	}
	value := fmt.Sprintf("%d@%d", b-a+1, a)
	if ByteRangeHeader(value) == "" {
		return "", dashError("INVALID_MPD", "DASH 字节范围超出支持限制。")
	}
	return value, nil
}
func expandDASH(raw string, rep, segment *dashNode, live bool) (string, bool, error) {
	number := segment.attr("startNumber")
	if number == "" {
		number = "1"
	}
	timeValue := "0"
	knownTime := !live
	knownNumber := !live
	if timeline := segment.child("SegmentTimeline"); timeline != nil {
		if s := timeline.child("S"); s != nil {
			timeValue = s.attr("t")
			if timeValue == "" {
				timeValue = "0"
			}
			knownTime = true
			knownNumber = true
		}
	}
	known := true
	var expansionErr error
	out := dashToken.ReplaceAllStringFunc(raw, func(token string) string {
		if token == "$$" {
			return "$"
		}
		parts := dashToken.FindStringSubmatch(token)
		value := ""
		switch parts[1] {
		case "RepresentationID":
			value = rep.attr("id")
		case "Bandwidth":
			value = rep.attr("bandwidth")
		case "Number":
			value = number
			known = known && knownNumber
		case "Time":
			value = timeValue
			known = known && knownTime
		}
		if value == "" {
			expansionErr = dashError("INVALID_TEMPLATE", "DASH 模板缺少 Representation 标识或带宽。")
			return ""
		}
		if parts[1] == "RepresentationID" {
			if strings.ContainsAny(value, "/\\:%?#$\x00\r\n") || value == "." || value == ".." {
				expansionErr = dashError("INVALID_TEMPLATE", "Representation 标识不能注入地址路径。")
				return ""
			}
		} else if _, e := strconv.ParseUint(value, 10, 64); e != nil {
			expansionErr = dashError("INVALID_TEMPLATE", "DASH 模板数字无效。")
			return ""
		}
		if parts[2] != "" {
			n, e := strconv.ParseUint(value, 10, 64)
			if e != nil {
				expansionErr = dashError("INVALID_TEMPLATE", "DASH 模板数字无效。")
				return ""
			}
			width, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(parts[2], "%0"), "d"))
			value = fmt.Sprintf("%0*d", width, n)
		}
		return value
	})
	return out, known, expansionErr
}

type dashDocument struct {
	body    []byte
	live    bool
	samples []Resource
}

// Flatten inherited segment addressing at each Representation before rewriting.
// This preserves Representation-specific BaseURL resolution for inherited templates.
func rewriteDASH(body []byte, rawURL string, mapResource func(Resource) (string, error)) (dashDocument, error) {
	var result dashDocument
	root, err := parseDASH(body)
	if err != nil {
		return result, err
	}
	result.live = root.attr("type") == "dynamic"
	representations := 0
	emitted := 0
	cloneWork := 0
	var nodeCount func(*dashNode) int
	nodeCount = func(n *dashNode) int {
		if n == nil {
			return 0
		}
		count := 1
		for _, ch := range n.children {
			count += nodeCount(ch)
		}
		return count
	}
	origins := map[string]bool{}
	validateMediaURL := func(raw string) error {
		if raw == rawURL {
			return dashError("INVALID_MPD", "DASH 媒体地址不能指向清单本身。")
		}
		return nil
	}
	mapURL := func(raw, kind string) (string, error) {
		masked, _, e := maskResolvedDASH(raw)
		if e != nil {
			return "", e
		}
		u, e := url.Parse(masked)
		if e != nil || !safeDASHPath(u.EscapedPath()) {
			return "", dashError("INVALID_URL", "DASH 地址无效。")
		}
		origins[u.Scheme+"://"+u.Host] = true
		if len(origins) > 32 {
			return "", dashError("MANIFEST_ORIGIN_LIMIT", "DASH 上游来源超过 32 个。")
		}
		return mapResource(Resource{URL: raw, Kind: kind})
	}
	var walk func(*dashNode, string, *dashNode, bool) error
	walk = func(n *dashNode, base string, inherited *dashNode, sample bool) error {
		hierarchy := n.name.Local == "MPD" || n.name.Local == "Period" || n.name.Local == "AdaptationSet" || n.name.Local == "Representation"
		localBase := base
		var own *dashNode
		baseCount := 0
		if hierarchy {
			for _, ch := range n.children {
				switch ch.name.Local {
				case "BaseURL":
					baseCount++
					if baseCount > 1 {
						return dashError("UNSUPPORTED_MPD", "暂不支持同层多个 BaseURL 备选来源。")
					}
					var e error
					localBase, e = resolveDASH(base, strings.TrimSpace(ch.text))
					if e != nil {
						return e
					}
				case "SegmentBase", "SegmentList", "SegmentTemplate":
					if own != nil {
						return dashError("INVALID_MPD", "DASH 层级包含冲突的分段描述。")
					}
					own = ch
				}
			}
			cloneWork += nodeCount(inherited) + nodeCount(own)
			if cloneWork > 100000 {
				return dashError("MANIFEST_LIMIT", "DASH 继承展开超过元素限制。")
			}
			inherited = inheritDASH(inherited, own)
		}
		kept := make([]*dashNode, 0, len(n.children))
		firstRep := true
		for _, ch := range n.children {
			if hierarchy && ch.name.Local == "BaseURL" {
				// Keep availabilityTimeOffset/Complete and other BaseURL metadata
				// at their original inheritance level, while fixing the address.
				mapped, e := mapURL(localBase, "dash-media")
				if e != nil {
					return e
				}
				ch.text = mapped
				kept = append(kept, ch)
				continue
			}
			if hierarchy && (ch.name.Local == "SegmentBase" || ch.name.Local == "SegmentList" || ch.name.Local == "SegmentTemplate") {
				continue
			}
			switch ch.name.Local {
			case "Location":
				raw, e := resolveDASH(rawURL, strings.TrimSpace(ch.text))
				if e != nil {
					return e
				}
				ch.text, e = mapURL(raw, "dash-manifest")
				if e != nil {
					return e
				}
			case "UTCTiming":
				scheme := ch.attr("schemeIdUri")
				if strings.Contains(scheme, ":http-") {
					raw, e := resolveDASH(rawURL, ch.attr("value"))
					if e != nil {
						return e
					}
					mapped, e := mapURL(raw, "dash-clock")
					if e != nil {
						return e
					}
					ch.set("value", mapped)
				} else if !strings.Contains(scheme, ":direct:") {
					return dashError("UNSUPPORTED_MPD", "不支持此 DASH 时钟协议。")
				}
			default:
				childSample := sample
				if n.name.Local == "AdaptationSet" && ch.name.Local == "Representation" {
					childSample = firstRep
					firstRep = false
				}
				if e := walk(ch, localBase, inherited, childSample); e != nil {
					return e
				}
			}
			kept = append(kept, ch)
		}
		n.children = kept
		if n.name.Local != "Representation" {
			return nil
		}
		representations++
		mapped, e := mapURL(localBase, "dash-media")
		if e != nil {
			return e
		}
		if baseCount == 0 {
			n.children = append(n.children, &dashNode{name: xml.Name{Space: n.name.Space, Local: "BaseURL"}, text: mapped})
		}
		addSample := func(raw, kind, byteRange string) error {
			if e := validateMediaURL(raw); e != nil {
				return e
			}
			br, e := dashRange(byteRange)
			if e != nil {
				return e
			}
			if sample && len(result.samples) < 64 {
				result.samples = append(result.samples, Resource{URL: raw, Kind: kind, Range: br})
			}
			return nil
		}
		if inherited == nil {
			if localBase == rawURL {
				return dashError("INVALID_MPD", "Representation 缺少媒体或分段地址。")
			}
			return addSample(localBase, "segment", "")
		}
		segment := inherited
		for _, key := range []string{"timescale", "duration", "startNumber", "presentationTimeOffset"} {
			if value := segment.attr(key); value != "" {
				number, err := strconv.ParseUint(value, 10, 63)
				if err != nil || (number == 0 && (key == "timescale" || key == "duration")) {
					return dashError("INVALID_MPD", "DASH 分段数字参数无效。")
				}
			}
		}
		if segment.name.Local == "SegmentTemplate" {
			if segment.attr("media") == "" {
				return dashError("INVALID_TEMPLATE", "SegmentTemplate 缺少 media 模板。")
			}
			for _, key := range []string{"initialization", "media", "index", "bitstreamSwitching"} {
				if raw := segment.attr(key); raw != "" {
					abs, e := resolveDASH(localBase, raw)
					if e != nil {
						return e
					}
					expanded, known, e := expandDASH(abs, n, segment, result.live)
					if e != nil {
						return e
					}
					if known {
						if e = validateMediaURL(expanded); e != nil {
							return e
						}
					}
					mapped, e := mapURL(abs, "dash-media")
					if e != nil {
						return e
					}
					segment.set(key, mapped)
					if known && (key == "initialization" || key == "media") {
						kind := "segment"
						if key == "initialization" {
							kind = "init"
						}
						if e := addSample(expanded, kind, ""); e != nil {
							return e
						}
					}
				}
			}
		}
		mediaFound := false
		for _, ch := range segment.children {
			switch ch.name.Local {
			case "Initialization", "RepresentationIndex", "BitstreamSwitching":
				raw, e := resolveDASH(localBase, ch.attr("sourceURL"))
				if e != nil {
					return e
				}
				if e = validateMediaURL(raw); e != nil {
					return e
				}
				mapped, e := mapURL(raw, "dash-media")
				if e != nil {
					return e
				}
				ch.set("sourceURL", mapped)
				if _, e = dashRange(ch.attr("range")); e != nil {
					return e
				}
				if ch.name.Local == "Initialization" {
					if e = addSample(raw, "init", ch.attr("range")); e != nil {
						return e
					}
				}
			case "SegmentURL":
				for _, key := range []string{"media", "index"} {
					raw := ch.attr(key)
					if raw == "" && key == "index" {
						continue
					}
					abs, e := resolveDASH(localBase, raw)
					if e != nil {
						return e
					}
					if e = validateMediaURL(abs); e != nil {
						return e
					}
					mapped, e := mapURL(abs, "dash-media")
					if e != nil {
						return e
					}
					ch.set(key, mapped)
					if _, e = dashRange(ch.attr(key + "Range")); e != nil {
						return e
					}
					if key == "media" && !mediaFound {
						if e = addSample(abs, "segment", ch.attr("mediaRange")); e != nil {
							return e
						}
						mediaFound = true
					}
				}
			case "SegmentTimeline":
				if len(ch.children) == 0 {
					return dashError("INVALID_MPD", "SegmentTimeline 为空。")
				}
				for _, s := range ch.children {
					d, e := strconv.ParseUint(s.attr("d"), 10, 63)
					if s.name.Local != "S" || e != nil || d == 0 {
						return dashError("INVALID_MPD", "SegmentTimeline 的时长无效。")
					}
					for _, key := range []string{"t", "r"} {
						if v := s.attr(key); v != "" {
							num, e := strconv.ParseInt(v, 10, 64)
							if e != nil || num < 0 && (key != "r" || num != -1) {
								return dashError("INVALID_MPD", "SegmentTimeline 的时间或重复次数无效。")
							}
						}
					}
				}
			default:
				return dashError("UNSUPPORTED_MPD", "不支持此 DASH 分段元素。")
			}
		}
		if segment.name.Local == "SegmentList" && !mediaFound {
			return dashError("INVALID_MPD", "SegmentList 没有媒体分片。")
		}
		if segment.name.Local == "SegmentBase" {
			if localBase == rawURL {
				return dashError("INVALID_MPD", "SegmentBase 缺少媒体 BaseURL。")
			}
			kind := "segment"
			if segment.attr("indexRange") != "" {
				kind = "index"
			}
			if e := addSample(localBase, kind, segment.attr("indexRange")); e != nil {
				return e
			}
		}
		n.children = append(n.children, segment)
		return nil
	}
	if err = walk(root, rawURL, nil, true); err != nil {
		return result, err
	}
	if representations == 0 {
		return result, dashError("INVALID_MPD", "DASH 清单没有 Representation。")
	}
	var buf bytes.Buffer
	enc := xml.NewEncoder(&buf)
	var write func(*dashNode) error
	write = func(n *dashNode) error {
		emitted++
		if emitted > 50000 || buf.Len() > 8*dashBodyLimit {
			return dashError("MANIFEST_LIMIT", "展开后的 DASH 元素过多。")
		}
		start := xml.StartElement{Name: n.name, Attr: n.attrs}
		if e := enc.EncodeToken(start); e != nil {
			return e
		}
		if strings.TrimSpace(n.text) != "" {
			if e := enc.EncodeToken(xml.CharData(n.text)); e != nil {
				return e
			}
		}
		for _, ch := range n.children {
			if e := write(ch); e != nil {
				return e
			}
		}
		return enc.EncodeToken(start.End())
	}
	if err = write(root); err != nil {
		return result, err
	}
	if err = enc.Flush(); err != nil {
		return result, err
	}
	if buf.Len() > 8*dashBodyLimit {
		return result, dashError("MANIFEST_LIMIT", "展开后的 DASH 清单过大。")
	}
	result.body = buf.Bytes()
	return result, nil
}
func (c *Client) probeDASH(ctx context.Context, candidate Candidate, raw string, body []byte, result *ProbeResult) error {
	doc, err := rewriteDASH(body, raw, func(r Resource) (string, error) { return r.URL, nil })
	if err != nil {
		return err
	}
	result.Live = doc.live
	for _, resource := range doc.samples {
		_, res, e := c.readBounded(ctx, candidate, resource, 4096)
		if e != nil {
			return e
		}
		result.Checks = append(result.Checks, Check{Kind: resource.Kind, Origin: DescribeURL(res.Request.URL.String()), Status: res.StatusCode})
	}
	return nil
}
