package main

import (
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Custom emotes: each server's own pictures, written :name: in messages.
var emotes = library{
	table:    "emotes",
	noun:     "emote",
	kind:     imageKind,
	maxSize:  512 << 10,
	tooLarge: "emotes can be up to 512 KB",
	maxItems: 200,
	name: func(s string) (string, error) {
		s = strings.TrimSpace(strings.Trim(s, ":"))
		if !emoteName.MatchString(s) {
			return "", errors.New("names are 2-32 letters, digits or _")
		}
		return s, nil
	},
}

var emoteName = regexp.MustCompile(`^[A-Za-z0-9_]{2,32}$`)

// Stickers: each server's bigger pictures, sent on their own as a message.
var stickers = library{
	table:    "stickers",
	noun:     "sticker",
	kind:     imageKind,
	maxSize:  512 << 10,
	tooLarge: "stickers can be up to 512 KB",
	maxItems: 100,
	name:     displayName,
}

// Soundboard: each server's short sounds, played to everyone in a call. Playing them goes through
// the call itself (LiveKit data messages); the server only keeps the list.
var sounds = library{
	table:    "sounds",
	noun:     "sound",
	kind:     soundKind,
	maxSize:  1 << 20,
	tooLarge: "sounds can be up to 1 MB",
	maxItems: 100,
	name:     displayName,
}

// displayName checks a sticker's or sound's name: any text, one line.
func displayName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 32 || strings.ContainsFunc(s, unicode.IsControl) {
		return "", errors.New("names are 1-32 characters")
	}
	return s, nil
}

func migrateStickers(tx *sql.Tx) error { return stickers.create(tx) }

func migrateEmotes(tx *sql.Tx) error { return emotes.create(tx) }
func migrateSounds(tx *sql.Tx) error { return sounds.create(tx) }
