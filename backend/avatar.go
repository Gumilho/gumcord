package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

const maxAvatarSize = 2 << 20

var avatarClient = &http.Client{Timeout: 5 * time.Second}

// importAvatar copies the identity provider's profile picture into the upload store, so clients
// load it from Gumcord instead of PocketID. Files are named by content: an unchanged picture keeps
// its URL, and its browser cache, across logins. Returns "" when there's nothing usable.
func importAvatar(ctx context.Context, pictureURL string) string {
	if pictureURL == "" || !sameHost(pictureURL, oidcIssuer) {
		return "" // only fetch from the identity provider itself
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pictureURL, nil)
	if err != nil {
		return ""
	}
	res, err := avatarClient.Do(req)
	if err != nil {
		log.Printf("avatar import: %v", err)
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		log.Printf("avatar import: %s returned %s", pictureURL, res.Status)
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxAvatarSize+1))
	if err != nil || len(data) > maxAvatarSize {
		return ""
	}
	ext, ok := imageExts[http.DetectContentType(data)]
	if !ok {
		return ""
	}

	sum := sha256.Sum256(data)
	name := "avatar-" + hex.EncodeToString(sum[:12]) + ext
	file := filepath.Join(uploadDir, name)
	if _, err := os.Stat(file); err != nil {
		if err := os.WriteFile(file, data, 0o644); err != nil {
			log.Printf("avatar import: %v", err)
			return ""
		}
	}
	return "/files/" + name
}

func sameHost(a, b string) bool {
	ua, err1 := url.Parse(a)
	ub, err2 := url.Parse(b)
	return err1 == nil && err2 == nil && ua.Scheme == ub.Scheme && ua.Host == ub.Host
}
