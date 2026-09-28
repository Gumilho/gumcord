# One image for the web app and the Go backend; the backend serves both.

FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM golang:1.27-alpine AS backend
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /gumcord .

FROM alpine:3
COPY --from=backend /gumcord /app/gumcord
COPY --from=web /src/build /app/web
ENV STATIC_DIR=/app/web DATA_DIR=/data ADDR=:8080
# UID 1000 matches the usual first user on the host, so a bind-mounted ./data stays writable.
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8080
CMD ["/app/gumcord"]
