-- ============================================================
--  NACOS AWARDS 2026 — Complete Database Schema
--  Run ONCE in your Supabase SQL Editor (Dashboard > SQL Editor)
--  All CREATE statements use IF NOT EXISTS — safe to re-run
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Profiles (synced from auth.users via trigger) ─────────────
CREATE TABLE IF NOT EXISTS profiles (
    id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email         VARCHAR(255) UNIQUE NOT NULL,
    fullname      VARCHAR(255) NOT NULL,
    department    VARCHAR(255),
    matric_number VARCHAR(100) UNIQUE,
    role          VARCHAR(50) NOT NULL DEFAULT 'user'
                  CHECK (role IN ('admin','moderator','user')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Categories ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        VARCHAR(255) UNIQUE NOT NULL,
    slug        VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Contestants ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contestants (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    fullname    VARCHAR(255) NOT NULL,
    avatar_url  TEXT NOT NULL,
    bio         TEXT,
    vote_count  INT NOT NULL DEFAULT 0 CHECK (vote_count >= 0),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Transactions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID REFERENCES profiles(id) ON DELETE SET NULL,
    contestant_id UUID REFERENCES contestants(id) ON DELETE SET NULL,
    category_id   UUID REFERENCES categories(id)  ON DELETE SET NULL,
    reference     VARCHAR(255) UNIQUE NOT NULL,
    amount        NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    quantity      INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    currency      VARCHAR(10) DEFAULT 'NGN',
    status        VARCHAR(50)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','success','failed')),
    metadata      JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Votes (immutable audit trail) ────────────────────────────
CREATE TABLE IF NOT EXISTS votes (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id UUID UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    category_id    UUID REFERENCES categories(id)   ON DELETE CASCADE,
    contestant_id  UUID REFERENCES contestants(id)  ON DELETE CASCADE,
    user_id        UUID REFERENCES profiles(id)     ON DELETE SET NULL,
    quantity       INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Password Resets ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_resets (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      VARCHAR(255) NOT NULL,
    token      VARCHAR(64)  NOT NULL,
    expires_at TIMESTAMPTZ  NOT NULL,
    created_at TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Audit Logs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES profiles(id) ON DELETE SET NULL,
    action     VARCHAR(255) NOT NULL,
    target     VARCHAR(255),
    ip_address VARCHAR(45),
    metadata   JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Processed Webhooks (replay attack prevention) ─────────────
CREATE TABLE IF NOT EXISTS processed_webhooks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_email       ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_matric      ON profiles(matric_number);
CREATE INDEX IF NOT EXISTS idx_categories_slug      ON categories(slug);
CREATE INDEX IF NOT EXISTS idx_contestants_cat      ON contestants(category_id);
CREATE INDEX IF NOT EXISTS idx_contestants_votes    ON contestants(category_id, vote_count DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_ref     ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_transactions_status  ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_user    ON transactions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_votes_contestant     ON votes(contestant_id);
CREATE INDEX IF NOT EXISTS idx_votes_category       ON votes(category_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_event       ON processed_webhooks(event_id);
CREATE INDEX IF NOT EXISTS idx_pwreset              ON password_resets(email, token);
CREATE INDEX IF NOT EXISTS idx_audit_action         ON audit_logs(action);

-- ── Row Level Security ────────────────────────────────────────
ALTER TABLE categories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE contestants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE votes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles          ENABLE ROW LEVEL SECURITY;

-- Public read (leaderboard/category pages require no auth)
DROP POLICY IF EXISTS "Public read categories"  ON categories;
CREATE POLICY "Public read categories"  ON categories  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public read contestants" ON contestants;
CREATE POLICY "Public read contestants" ON contestants FOR SELECT USING (true);

-- ── Supabase Storage: contestant-photos bucket ────────────────
-- Run this separately in SQL Editor:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('contestant-photos', 'contestant-photos', true)
-- ON CONFLICT DO NOTHING;
--
-- CREATE POLICY "Public read photos" ON storage.objects FOR SELECT USING (bucket_id = 'contestant-photos');
-- CREATE POLICY "Auth upload photos" ON storage.objects FOR INSERT
--   WITH CHECK (bucket_id = 'contestant-photos' AND auth.role() = 'authenticated');

-- ── RPC Functions ─────────────────────────────────────────────

-- Atomic vote processor
CREATE OR REPLACE FUNCTION process_vote_transaction(
    p_tx_ref  VARCHAR,
    p_cat_id  UUID,
    p_con_id  UUID,
    p_usr_id  UUID,
    p_qty     INT
)
RETURNS BOOLEAN AS $$
DECLARE
    v_rows  INT;
    v_tx_id UUID;
BEGIN
    UPDATE transactions
    SET    status = 'success', updated_at = NOW()
    WHERE  reference = p_tx_ref AND status = 'pending'
    RETURNING id INTO v_tx_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN FALSE; END IF;

    INSERT INTO votes (transaction_id, category_id, contestant_id, user_id, quantity)
    VALUES (v_tx_id, p_cat_id, p_con_id, p_usr_id, p_qty);

    UPDATE contestants SET vote_count = vote_count + p_qty WHERE id = p_con_id;

    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revenue sum
CREATE OR REPLACE FUNCTION get_total_revenue()
RETURNS NUMERIC AS $$
DECLARE rev NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO rev FROM transactions WHERE status = 'success';
    RETURN rev;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Auto-sync new Supabase Auth users into profiles ───────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, fullname, role)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'fullname', split_part(NEW.email,'@',1)),
        'user'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── Seed default categories ───────────────────────────────────
INSERT INTO categories (id, name, slug, description) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Entrepreneur of the Year',    'entrepreneur',    'Recognising exceptional business mindsets and innovation.'),
  ('22222222-2222-2222-2222-222222222222', 'Freshman of the Year (Male)', 'freshman-male',   'Outstanding male achievements in the first academic year.'),
  ('33333333-3333-3333-3333-333333333333', 'Freshman of the Year (Female)','freshman-female','Outstanding female achievements in the first academic year.'),
  ('44444444-4444-4444-4444-444444444444', 'Creator of the Year (Male)',  'creator-male',    'Exceptional content creation by male students.'),
  ('55555555-5555-5555-5555-555555555555', 'Creator of the Year (Female)','creator-female',  'Exceptional content creation by female students.')
ON CONFLICT DO NOTHING;

-- ============================================================
-- AFTER RUNNING THIS SCHEMA:
--
-- 1. Go to Supabase Dashboard > Authentication > Users
-- 2. Create admin@nacos.com with password adminnacos2026
-- 3. Run in SQL Editor:
--    UPDATE profiles SET role = 'admin' WHERE email = 'admin@nacos.com';
--
-- 4. Create contestant-photos storage bucket:
--    Go to Storage > New Bucket > name: contestant-photos > Public ON
-- ============================================================
-- ── BUG-22 FIX: Missing index on transactions(contestant_id) ─────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_contestant ON transactions(contestant_id);

-- ── BUG-21 FIX: Improved process_vote_transaction with better idempotency ────
-- Replaces the original version above
CREATE OR REPLACE FUNCTION process_vote_transaction(
    p_tx_ref  VARCHAR,
    p_cat_id  UUID,
    p_con_id  UUID,
    p_usr_id  UUID,
    p_qty     INT
)
RETURNS BOOLEAN AS $$
DECLARE
    v_rows  INT;
    v_tx_id UUID;
BEGIN
    -- Atomic: update ONLY if still pending (prevents race conditions)
    UPDATE transactions
    SET    status = 'success', updated_at = NOW()
    WHERE  reference = p_tx_ref AND status = 'pending'
    RETURNING id INTO v_tx_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    -- If 0 rows updated: already processed or not found → return false (idempotent)
    IF v_rows = 0 THEN RETURN FALSE; END IF;

    -- Insert vote record; ON CONFLICT DO NOTHING prevents duplicate errors
    INSERT INTO votes (transaction_id, category_id, contestant_id, user_id, quantity)
    VALUES (v_tx_id, p_cat_id, p_con_id, p_usr_id, p_qty)
    ON CONFLICT (transaction_id) DO NOTHING;

    -- Increment vote count atomically
    UPDATE contestants SET vote_count = vote_count + p_qty WHERE id = p_con_id;

    RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
    RAISE; -- propagate so caller sees the error
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
