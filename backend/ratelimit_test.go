package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestLimiterBurstThenRefuses(t *testing.T) {
	l := newLimiter(0.001, 3)
	for i := range 3 {
		if !l.allow("a") {
			t.Fatalf("request %d refused inside the burst", i+1)
		}
	}
	if l.allow("a") {
		t.Fatal("request past the burst was allowed")
	}
}

func TestLimiterKeysAreIndependent(t *testing.T) {
	l := newLimiter(0.001, 1)
	if !l.allow("a") || l.allow("a") {
		t.Fatal("a should get exactly one")
	}
	if !l.allow("b") {
		t.Fatal("a spending its token took b's")
	}
	if !l.allow(int64(1)) || !l.allow(1) {
		t.Fatal("keys of different types must not collide")
	}
}

func TestLimiterRefills(t *testing.T) {
	l := newLimiter(10, 1) // a token every 100ms
	l.allow("a")
	if l.allow("a") {
		t.Fatal("bucket should be empty")
	}
	l.buckets["a"].last = time.Now().Add(-time.Second) // a second passes
	if !l.allow("a") {
		t.Fatal("bucket should have refilled")
	}
	if l.allow("a") {
		t.Fatal("refill must not exceed the burst")
	}
}

func TestLimiterForgetsRefilledKeys(t *testing.T) {
	l := newLimiter(1, 1)
	old := time.Now().Add(-time.Hour)
	for i := range 10_000 {
		l.buckets[i] = &bucket{tokens: 1, last: old}
	}
	l.allow("new")
	if n := len(l.buckets); n > 2 {
		t.Fatalf("%d buckets kept, want the stale ones dropped", n)
	}
}

func TestTooMany(t *testing.T) {
	rec := httptest.NewRecorder()
	tooMany(rec)
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("got %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}
