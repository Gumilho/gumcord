# Everything that checks the code, fast and without a browser or Docker: `make test`.
# `make e2e` and `make a11y` drive the real app in a browser (see e2e/README.md).

.PHONY: test test-backend test-web check e2e a11y

test: test-backend test-web check

test-backend:
	cd backend && go vet ./... && go test -count=1 ./...

test-web:
	npm test

check:
	npm run check

e2e:
	cd e2e && ./run.sh smoke

a11y:
	cd e2e && ./run.sh a11y

deploy:
	@docker compose up -d --build