-- @lat: [[docs#Docs]]
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX users_email_idx ON users (email);

CREATE OR REPLACE VIEW active_users AS
    SELECT id, email FROM users WHERE created_at > NOW() - INTERVAL '30 days';

CREATE OR REPLACE FUNCTION greet(name TEXT)
RETURNS TEXT AS $$
    SELECT 'Hello, ' || name;
$$ LANGUAGE sql;

CREATE TYPE mood AS ENUM ('happy', 'sad');
