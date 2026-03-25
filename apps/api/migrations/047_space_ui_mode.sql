ALTER TABLE spaces
ADD COLUMN ui_mode TEXT NOT NULL DEFAULT 'simple';

ALTER TABLE spaces
ADD CONSTRAINT spaces_ui_mode_check CHECK (ui_mode IN ('simple', 'governance'));

