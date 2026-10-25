package platform

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type Config struct {
	PlayerPath  string `json:"playerPath"`
	ProxyMode   string `json:"proxyMode"`
	ProxyURL    string `json:"proxyUrl"`
	FFprobePath string `json:"ffprobePath"`
}

func DefaultConfig() Config { return Config{ProxyMode: "system"} }
func ConfigPath() string {
	root := os.Getenv("LOCALAPPDATA")
	if root == "" {
		root, _ = os.UserConfigDir()
	}
	return filepath.Join(root, "PotBridge", "config.json")
}
func (c Config) Validate() error {
	if c.ProxyMode != "system" && c.ProxyMode != "direct" && c.ProxyMode != "manual" {
		return errors.New("请选择系统代理、直连或手动代理。")
	}
	for _, p := range []string{c.PlayerPath, c.FFprobePath} {
		if p != "" {
			if !filepath.IsAbs(p) || !strings.EqualFold(filepath.Ext(p), ".exe") {
				return errors.New("请选择可执行文件的完整 .exe 路径。")
			}
			info, err := os.Stat(p)
			if err != nil || info.IsDir() {
				return errors.New("指定的可执行文件不存在。")
			}
		}
	}
	if c.ProxyMode == "manual" {
		u, err := url.Parse(c.ProxyURL)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return errors.New("手动代理应为 http://主机:端口，不接受含账号密码的地址。")
		}
	}
	return nil
}
func LoadConfig(filename string) (Config, error) {
	c := DefaultConfig()
	data, err := os.ReadFile(filename)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if len(data) > 16384 {
		return c, errors.New("配置文件过大。")
	}
	err = json.Unmarshal(data, &c)
	return c, err
}
func SaveConfig(filename string, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(filename), "config-*.tmp")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(name, filename)
}
func ParseProxySpec(spec, scheme string) (*url.URL, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" || strings.EqualFold(spec, "DIRECT") {
		return nil, nil
	}
	selected := ""
	for _, part := range strings.Split(spec, ";") {
		part = strings.TrimSpace(part)
		if key, value, ok := strings.Cut(part, "="); ok {
			if strings.EqualFold(key, scheme) {
				selected = value
				break
			}
		} else if selected == "" {
			selected = part
		}
	}
	if selected == "" {
		return nil, errors.New("当前系统代理未提供此协议的可用代理。")
	}
	selected = strings.TrimPrefix(selected, "PROXY ")
	if !strings.Contains(selected, "://") {
		selected = "http://" + selected
	}
	u, err := url.Parse(selected)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("暂不支持此系统代理格式。")
	}
	return u, nil
}
func ProxyBypassed(host, spec string) bool {
	host = strings.ToLower(host)
	for _, pattern := range strings.Split(spec, ";") {
		pattern = strings.ToLower(strings.TrimSpace(pattern))
		if pattern == "<local>" && !strings.Contains(host, ".") {
			return true
		}
		if matched, _ := path.Match(pattern, host); pattern != "" && matched {
			return true
		}
	}
	return false
}
