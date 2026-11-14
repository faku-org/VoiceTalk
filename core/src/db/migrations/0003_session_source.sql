-- Where a session came from (ADR 0010). call = the app's own microphone, discord = a Discord voice channel.
-- No CHECK on purpose: new capture sources add values without a table rebuild.
ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'call';

-- Real name of the speaker in a multi-speaker session (Discord display name). NULL for the one-mic call.
ALTER TABLE utterances ADD COLUMN speaker_name TEXT;
