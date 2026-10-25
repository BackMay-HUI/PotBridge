//go:build windows

package platform

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if output := os.Getenv("POTBRIDGE_TEST_PLAYER_OUTPUT"); output != "" {
		data, _ := json.Marshal(os.Args[1:])
		if os.WriteFile(output, data, 0600) != nil {
			os.Exit(2)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestLaunchPassesMediaAsOneArgumentWithoutShell(t *testing.T) {
	directory := t.TempDir()
	executable := filepath.Join(directory, "Player with spaces.exe")
	binary, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(executable, binary, 0700); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "args.json")
	t.Setenv("POTBRIDGE_TEST_PLAYER_OUTPUT", output)
	mediaURL := "http://127.0.0.1:49152/s/token/root/media.mp4?x=1&y=2"
	if err = LaunchPlayer(executable, mediaURL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		data, readErr := os.ReadFile(output)
		var args []string
		if readErr == nil && json.Unmarshal(data, &args) == nil {
			if len(args) != 1 || args[0] != mediaURL {
				t.Fatalf("unexpected arguments: %v", args)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("test player did not receive the launch arguments")
}
