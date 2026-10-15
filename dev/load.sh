#!/usr/bin/env bash
# LIS 개발 DB 생성 (SQLite)
set -e
cd "$(dirname "$0")"
rm -f lis_dev.db
sqlite3 lis_dev.db ".read schema.sql"
sqlite3 lis_dev.db "PRAGMA foreign_keys=ON;" ".read seed.sql"
echo "생성 완료: dev/lis_dev.db"
sqlite3 lis_dev.db "PRAGMA foreign_key_check;" && echo "FK 무결성: OK"
