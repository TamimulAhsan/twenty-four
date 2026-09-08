-- +goose Up
-- What a business is, beyond what it sells.
--
-- Three columns that were missing and are not optional for long: an invoice
-- without an address and a tax number is not an invoice, and Invoicing will
-- need both from here rather than inventing its own copy. Empty until somebody
-- records them, because every tenant that already exists was created without
-- them and backfilling a guess is worse than an empty field a specialist can
-- see is empty.
ALTER TABLE tenants ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN city    TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN tax_id  TEXT NOT NULL DEFAULT '';

-- Where a tenant is in its life.
--
-- Distinct from health, which the admin console derives from this plus the
-- state of the provisioning run plus the seat quota. This column is what the
-- tenant IS; health is whether anybody needs to do something about it, and
-- storing a derived judgement is how the two drift apart.
--
-- Existing rows are live: they were provisioned before this column existed, so
-- by definition their saga finished.
ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'live'
    CHECK (status IN ('provisioning','live','suspended','trial'));

-- The directory is read by status and by tier, and by nothing else. A tenant is
-- opened by primary key, so there is no index here for that.
CREATE INDEX tenants_status ON tenants (status);

-- Suspension is reversible and reasoned, so the reason is kept rather than
-- living only in the audit log. The console shows it on the tenant's own page,
-- and reading it back out of an event stream to render one line would be an
-- odd way to store a sentence.
ALTER TABLE tenants ADD COLUMN status_reason  TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN status_changed_at TIMESTAMPTZ;

-- +goose Down
DROP INDEX tenants_status;
ALTER TABLE tenants DROP COLUMN status_changed_at;
ALTER TABLE tenants DROP COLUMN status_reason;
ALTER TABLE tenants DROP COLUMN status;
ALTER TABLE tenants DROP COLUMN tax_id;
ALTER TABLE tenants DROP COLUMN city;
ALTER TABLE tenants DROP COLUMN address;
