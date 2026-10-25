package protocol

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	var b bytes.Buffer
	w := NewWriter(&b)
	if err := w.Send(map[string]any{"requestId": "one", "ok": true}); err != nil {
		t.Fatal(err)
	}
	data, err := Read(&b)
	if err != nil || !bytes.Contains(data, []byte(`"requestId":"one"`)) {
		t.Fatalf("%s %v", data, err)
	}
}
func TestRejectLargeAndTruncatedFrames(t *testing.T) {
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, uint32(MaxInput+1))
	if _, err := Read(&b); err == nil {
		t.Fatal("oversized accepted")
	}
	b.Reset()
	binary.Write(&b, binary.LittleEndian, uint32(10))
	b.WriteString("{}")
	if _, err := Read(&b); err != io.ErrUnexpectedEOF {
		t.Fatal(err)
	}
}
