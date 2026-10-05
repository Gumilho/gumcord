package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSniff(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{"png", tinyPNG, "image/png"},
		{"mp3 with ID3 tag", []byte("ID3\x03\x00\x00\x00\x00\x00\x00"), "audio/mpeg"},
		{"mp3 straight into a frame", []byte{0xFF, 0xFB, 0x90, 0x00}, "audio/mpeg"},
		{"plain text", []byte("hello"), "text/plain; charset=utf-8"},
		{"empty", nil, "text/plain; charset=utf-8"},
	}
	for _, tt := range tests {
		if got := sniff(tt.data); got != tt.want {
			t.Errorf("%s: sniff = %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestSaveUpload(t *testing.T) {
	uploadDir = t.TempDir()

	url, err := saveUpload(imageKind, "emote", tinyPNG)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "/files/emote-") || !strings.HasSuffix(url, ".png") {
		t.Fatalf("url %q", url)
	}
	if got, err := os.ReadFile(filepath.Join(uploadDir, filepath.Base(url))); err != nil || string(got) != string(tinyPNG) {
		t.Fatalf("stored file: %v", err)
	}

	// Named by content: the same file keeps its URL.
	if again, _ := saveUpload(imageKind, "emote", tinyPNG); again != url {
		t.Errorf("same content got %q then %q", url, again)
	}
	if other, _ := saveUpload(imageKind, "avatar", tinyPNG); other == url {
		t.Error("the prefix isn't part of the name")
	}
}

func TestSaveUploadRefusesOtherKinds(t *testing.T) {
	uploadDir = t.TempDir()
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`)
	html := []byte(`<!doctype html><script>alert(1)</script>`)

	for name, data := range map[string][]byte{"svg": svg, "html": html, "text": []byte("hi")} {
		if _, err := saveUpload(imageKind, "avatar", data); err != imageKind.err {
			t.Errorf("%s as an image: err = %v", name, err)
		}
	}
	if _, err := saveUpload(soundKind, "sound", tinyPNG); err != soundKind.err {
		t.Errorf("png as a sound: err = %v", err)
	}
	if _, err := saveUpload(soundKind, "sound", []byte{0xFF, 0xFB, 0x90, 0x00}); err != nil {
		t.Errorf("mp3 as a sound: %v", err)
	}
	if entries, _ := os.ReadDir(uploadDir); len(entries) != 1 {
		t.Errorf("%d files stored, want only the mp3", len(entries))
	}
}

func TestSafeExt(t *testing.T) {
	for in, want := range map[string]string{
		"photo.PNG":          ".png",
		"archive.tar.gz":     ".gz",
		"noext":              "",
		"trailing.":          "",
		"evil.p/../x":        "",
		"a.thisiswaytoolong": "",
		"weird.h tml":        "",
		"script.php5":        ".php5",
	} {
		if got := safeExt(in); got != want {
			t.Errorf("safeExt(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsImageExt(t *testing.T) {
	for ext, want := range map[string]bool{".png": true, ".jpg": true, ".webp": true, ".svg": false, ".html": false, "": false} {
		if got := isImageExt(ext); got != want {
			t.Errorf("isImageExt(%q) = %v", ext, got)
		}
	}
}
