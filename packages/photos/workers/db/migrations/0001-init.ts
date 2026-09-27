// Initial schema. One statement per array entry: D1's exec() splits on newlines, so multi-line
// statements go through batch() instead. Never edit an applied migration; add the next one.

export default [
  // ─── Storage ─────────────────────────────────────────────────────────────
  `CREATE TABLE storage_connections (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('r2-binding', 'r2-s3', 'nas')),
    name              TEXT NOT NULL,
    config_json       TEXT NOT NULL,
    -- 1 version byte, then the AES-GCM nonce and ciphertext (workers/storage/credentials.ts).
    secret_ciphertext BLOB,
    roles             TEXT NOT NULL DEFAULT '["original","derivative","replica"]',
    status            TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (status IN ('online', 'offline', 'error', 'unknown')),
    status_detail     TEXT,
    last_seen_at      INTEGER,
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,

  // ─── Photographers ───────────────────────────────────────────────────────
  `CREATE TABLE photographers (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    display_name      TEXT,
    avatar_asset_key  TEXT,
    website           TEXT,
    social_json       TEXT NOT NULL DEFAULT '{}',
    copyright         TEXT,
    default_tag_ids   TEXT NOT NULL DEFAULT '[]',
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX photographers_name ON photographers (name)`,
  // artist_text is normalizeArtist() of the EXIF Artist.
  `CREATE TABLE photographer_aliases (
    artist_text       TEXT PRIMARY KEY,
    photographer_id   TEXT NOT NULL REFERENCES photographers (id) ON DELETE CASCADE
  )`,

  // ─── Photos ──────────────────────────────────────────────────────────────
  // taken_at is always set: EXIF, else the file's mtime, else the import time.
  `CREATE TABLE photos (
    id                    TEXT PRIMARY KEY,
    title                 TEXT,
    caption               TEXT,
    taken_at              INTEGER NOT NULL,
    taken_at_source       TEXT NOT NULL DEFAULT 'exif'
                          CHECK (taken_at_source IN ('exif', 'file', 'import', 'manual')),
    timezone_offset_min   INTEGER,
    photographer_id       TEXT REFERENCES photographers (id) ON DELETE SET NULL,
    visibility            TEXT NOT NULL DEFAULT 'private'
                          CHECK (visibility IN ('private', 'unlisted', 'public')),
    download_allowed      INTEGER NOT NULL DEFAULT 0,
    favorite              INTEGER NOT NULL DEFAULT 0,
    rating                INTEGER CHECK (rating BETWEEN 0 AND 5),
    cover_thumbnail_asset_id TEXT,
    cover_preview_asset_id   TEXT,
    width                 INTEGER,
    height                INTEGER,
    phash                 TEXT,
    created_by            TEXT NOT NULL,
    updated_by            TEXT NOT NULL,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    deleted_at            INTEGER
  )`,
  `CREATE INDEX photos_taken ON photos (deleted_at, taken_at DESC, id DESC)`,
  `CREATE INDEX photos_created ON photos (deleted_at, created_at DESC, id DESC)`,
  `CREATE INDEX photos_fav ON photos (favorite, taken_at DESC)`,
  `CREATE INDEX photos_vis ON photos (visibility, taken_at DESC)`,
  `CREATE INDEX photos_photographer ON photos (photographer_id, taken_at DESC)`,

  // Searchable EXIF only; the raw dump lives in storage at raw_exif_key.
  `CREATE TABLE photo_exif (
    photo_id              TEXT PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
    make                  TEXT,
    model                 TEXT,
    camera_label          TEXT,
    lens_model            TEXT,
    focal_length_mm       REAL,
    focal_length_35mm     REAL,
    f_number              REAL,
    exposure_time_s       REAL,
    iso                   INTEGER,
    exposure_bias_ev      REAL,
    metering_mode         TEXT,
    flash_fired           INTEGER,
    white_balance         TEXT,
    orientation           INTEGER,
    pixel_width           INTEGER,
    pixel_height          INTEGER,
    gps_lat               REAL,
    gps_lon               REAL,
    gps_alt_m             REAL,
    artist                TEXT,
    copyright             TEXT,
    raw_exif_key          TEXT,
    raw_exif_connection_id TEXT
  )`,
  `CREATE INDEX photo_exif_camera ON photo_exif (model)`,
  `CREATE INDEX photo_exif_lens ON photo_exif (lens_model)`,
  `CREATE INDEX photo_exif_iso ON photo_exif (iso)`,
  `CREATE INDEX photo_exif_focal ON photo_exif (focal_length_35mm)`,

  `CREATE TABLE photo_assets (
    id                TEXT PRIMARY KEY,
    photo_id          TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    role              TEXT NOT NULL
                      CHECK (role IN ('original', 'replica', 'preview', 'thumbnail', 'sidecar')),
    replica_of_asset_id TEXT REFERENCES photo_assets (id) ON DELETE SET NULL,
    format_family     TEXT CHECK (format_family IN
                      ('raw', 'jpeg', 'heif', 'png', 'webp', 'avif', 'tiff', 'other')),
    is_primary        INTEGER NOT NULL DEFAULT 0,
    connection_id     TEXT NOT NULL REFERENCES storage_connections (id),
    storage_key       TEXT NOT NULL,
    original_filename TEXT,
    mime_type         TEXT NOT NULL,
    byte_size         INTEGER NOT NULL,
    sha256            TEXT,
    width             INTEGER,
    height            INTEGER,
    state             TEXT NOT NULL DEFAULT 'available'
                      CHECK (state IN ('pending', 'available', 'missing', 'deleting')),
    verified_at       INTEGER,
    created_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX photo_assets_photo ON photo_assets (photo_id, role)`,
  `CREATE INDEX photo_assets_dedupe ON photo_assets (sha256, byte_size)`,
  `CREATE UNIQUE INDEX photo_assets_location ON photo_assets (connection_id, storage_key)`,

  // ─── Tags ────────────────────────────────────────────────────────────────
  // path is the materialized ancestry, "/event/kemocon/"; descendants share its prefix.
  `CREATE TABLE tags (
    id                TEXT PRIMARY KEY,
    parent_id         TEXT REFERENCES tags (id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    path              TEXT NOT NULL UNIQUE,
    color             TEXT,
    created_at        INTEGER NOT NULL
  )`,
  `CREATE TABLE photo_tags (
    photo_id          TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    tag_id            TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    source            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual', 'import', 'photographer')),
    PRIMARY KEY (photo_id, tag_id)
  )`,
  `CREATE INDEX photo_tags_tag ON photo_tags (tag_id, photo_id)`,

  // ─── Albums ──────────────────────────────────────────────────────────────
  `CREATE TABLE albums (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    description       TEXT,
    cover_photo_id    TEXT REFERENCES photos (id) ON DELETE SET NULL,
    visibility        TEXT NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private', 'unlisted', 'public')),
    download_override INTEGER,
    exposure_policy_json TEXT,
    sort_order        TEXT NOT NULL DEFAULT 'taken_at_asc',
    created_by        TEXT NOT NULL,
    updated_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX albums_updated ON albums (updated_at DESC)`,
  `CREATE TABLE album_photos (
    album_id          TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    photo_id          TEXT NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    position          REAL NOT NULL,
    added_at          INTEGER NOT NULL,
    PRIMARY KEY (album_id, photo_id)
  )`,
  `CREATE INDEX album_photos_photo ON album_photos (photo_id)`,

  // ─── Publication ─────────────────────────────────────────────────────────
  `CREATE TABLE publication_targets (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('film-gallery', 'temporary-share')),
    name              TEXT NOT NULL,
    connection_id     TEXT NOT NULL REFERENCES storage_connections (id),
    config_json       TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE TABLE publications (
    id                TEXT PRIMARY KEY,
    target_id         TEXT NOT NULL REFERENCES publication_targets (id),
    album_id          TEXT REFERENCES albums (id) ON DELETE SET NULL,
    slug              TEXT NOT NULL,
    exposure_policy_json TEXT NOT NULL,
    expires_at        INTEGER,
    state             TEXT NOT NULL DEFAULT 'draft'
                      CHECK (state IN ('draft', 'publishing', 'published', 'unpublishing',
                                       'unpublished', 'failed')),
    manifest_revision INTEGER NOT NULL DEFAULT 0,
    published_at      INTEGER,
    last_error        TEXT,
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (target_id, slug)
  )`,
  `CREATE TABLE publication_objects (
    publication_id    TEXT NOT NULL REFERENCES publications (id) ON DELETE CASCADE,
    photo_id          TEXT NOT NULL,
    variant           TEXT NOT NULL CHECK (variant IN ('thumbnail', 'preview', 'original')),
    target_key        TEXT NOT NULL,
    sha256            TEXT NOT NULL,
    PRIMARY KEY (publication_id, photo_id, variant)
  )`,

  // ─── Direct share links (only with PHOTOS_DIRECT_SHARE) ─────────────────
  `CREATE TABLE share_links (
    token_hash        TEXT PRIMARY KEY,
    album_id          TEXT REFERENCES albums (id) ON DELETE CASCADE,
    photo_id          TEXT REFERENCES photos (id) ON DELETE CASCADE,
    exposure_policy_json TEXT NOT NULL,
    expires_at        INTEGER,
    revoked_at        INTEGER,
    created_by        TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    CHECK ((album_id IS NULL) <> (photo_id IS NULL))
  )`,

  // ─── Usage ───────────────────────────────────────────────────────────────
  `CREATE TABLE usage_samples (
    sampled_at        INTEGER PRIMARY KEY,
    d1_bytes          INTEGER NOT NULL,
    photo_count       INTEGER NOT NULL
  )`,
];
