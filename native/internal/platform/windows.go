//go:build windows

package platform

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

var winhttp = syscall.NewLazyDLL("winhttp.dll")
var winOpen = winhttp.NewProc("WinHttpOpen")
var winClose = winhttp.NewProc("WinHttpCloseHandle")
var winTimeout = winhttp.NewProc("WinHttpSetTimeouts")
var winIEConfig = winhttp.NewProc("WinHttpGetIEProxyConfigForCurrentUser")
var winProxyURL = winhttp.NewProc("WinHttpGetProxyForUrl")
var globalFree = syscall.NewLazyDLL("kernel32.dll").NewProc("GlobalFree")

type ieProxy struct {
	AutoDetect    int32
	AutoConfigURL *uint16
	Proxy         *uint16
	ProxyBypass   *uint16
}
type autoProxyOptions struct {
	Flags           uint32
	AutoDetectFlags uint32
	AutoConfigURL   *uint16
	ReservedPtr     uintptr
	Reserved        uint32
	AutoLogon       int32
}
type proxyInfo struct {
	AccessType  uint32
	Proxy       *uint16
	ProxyBypass *uint16
}

func utf16String(p *uint16) string {
	if p == nil {
		return ""
	}
	chars := make([]uint16, 0, 128)
	for i := uintptr(0); i < 32768; i++ {
		c := *(*uint16)(unsafe.Add(unsafe.Pointer(p), i*2))
		if c == 0 {
			break
		}
		chars = append(chars, c)
	}
	return string(utf16.Decode(chars))
}
func freeString(p *uint16) {
	if p != nil {
		globalFree.Call(uintptr(unsafe.Pointer(p)))
	}
}
func ResolveProxy(req *http.Request, c Config) (*url.URL, error) {
	if c.ProxyMode == "direct" {
		return nil, nil
	}
	if c.ProxyMode == "manual" {
		return url.Parse(c.ProxyURL)
	}
	var config ieProxy
	ok, _, callErr := winIEConfig.Call(uintptr(unsafe.Pointer(&config)))
	if ok == 0 {
		if callErr == syscall.Errno(2) {
			return nil, nil
		}
		return nil, errors.New("无法读取当前用户系统代理。")
	}
	defer freeString(config.AutoConfigURL)
	defer freeString(config.Proxy)
	defer freeString(config.ProxyBypass)
	proxy, bypass := utf16String(config.Proxy), utf16String(config.ProxyBypass)
	if config.AutoConfigURL != nil || config.AutoDetect != 0 {
		agent, _ := syscall.UTF16PtrFromString("PotBridge/0.1")
		handle, _, _ := winOpen.Call(uintptr(unsafe.Pointer(agent)), 1, 0, 0, 0)
		if handle == 0 {
			return nil, errors.New("无法初始化系统代理解析。")
		}
		defer winClose.Call(handle)
		winTimeout.Call(handle, 5000, 5000, 5000, 5000)
		options := autoProxyOptions{AutoConfigURL: config.AutoConfigURL}
		if config.AutoConfigURL != nil {
			options.Flags |= 2
		}
		if config.AutoDetect != 0 {
			options.Flags |= 1
			options.AutoDetectFlags = 3
		}
		target, _ := syscall.UTF16PtrFromString(req.URL.String())
		var info proxyInfo
		success, _, _ := winProxyURL.Call(handle, uintptr(unsafe.Pointer(target)), uintptr(unsafe.Pointer(&options)), uintptr(unsafe.Pointer(&info)))
		if success == 0 {
			return nil, errors.New("PAC 或自动代理解析失败，请核对网络设置或明确选择手动代理。")
		}
		defer freeString(info.Proxy)
		defer freeString(info.ProxyBypass)
		if info.AccessType == 1 {
			return nil, nil
		}
		proxy = utf16String(info.Proxy)
		bypass = utf16String(info.ProxyBypass)
	}
	if ProxyBypassed(req.URL.Hostname(), bypass) {
		return nil, nil
	}
	return ParseProxySpec(proxy, req.URL.Scheme)
}
func FindPlayer() string {
	for _, root := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
		for _, rel := range []string{`DAUM\PotPlayer\PotPlayerMini64.exe`, `PotPlayer\PotPlayerMini64.exe`, `DAUM\PotPlayer\PotPlayerMini.exe`, `PotPlayer\PotPlayer.exe`} {
			p := filepath.Join(root, rel)
			if info, err := os.Stat(p); err == nil && !info.IsDir() {
				return p
			}
		}
	}
	for _, key := range []string{`HKCR\potplayer\shell\open\command`, `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini64.exe`, `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\PotPlayerMini64.exe`} {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		cmd := exec.CommandContext(ctx, "reg.exe", "query", key, "/ve")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		out, err := cmd.Output()
		cancel()
		if err != nil {
			continue
		}
		_, value, ok := strings.Cut(string(out), "REG_SZ")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, `"`) {
			value, _, _ = strings.Cut(strings.TrimPrefix(value, `"`), `"`)
		} else if idx := strings.Index(strings.ToLower(value), ".exe"); idx >= 0 {
			value = value[:idx+4]
		}
		if info, err := os.Stat(value); err == nil && !info.IsDir() {
			return value
		}
	}
	return ""
}
func LaunchPlayer(executable, mediaURL string) error {
	if executable == "" {
		return errors.New("请先在设置中选择 PotPlayer 可执行文件。")
	}
	if err := (Config{PlayerPath: executable, ProxyMode: "direct"}).Validate(); err != nil {
		return err
	}
	cmd := exec.Command(executable, mediaURL)
	if err := cmd.Start(); err != nil {
		return errors.New("无法启动 PotPlayer，请核对可执行文件路径。")
	}
	go cmd.Wait()
	return nil
}

type limitedBuffer struct {
	data  []byte
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(b.data)+len(p) > b.limit {
		return 0, io.ErrShortBuffer
	}
	b.data = append(b.data, p...)
	return len(p), nil
}
func ProbeCodecs(parent context.Context, executable, mediaURL string) (any, error) {
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height:format=duration", "-of", "json", mediaURL)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out := &limitedBuffer{limit: 128 * 1024}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return nil, errors.New("ffprobe 未能完成媒体分析。")
	}
	var result any
	if err := json.Unmarshal(out.data, &result); err != nil {
		return nil, errors.New("ffprobe 返回无效分析结果。")
	}
	return result, nil
}
