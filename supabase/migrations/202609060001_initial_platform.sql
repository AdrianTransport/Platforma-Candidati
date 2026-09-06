create extension if not exists pgcrypto;

create type public.membership_role as enum ('platform_admin', 'campaign_owner', 'campaign_manager', 'editor', 'compliance_viewer');
create type public.campaign_status as enum ('draft', 'verification', 'active', 'paused', 'archived');
create type public.content_status as enum ('draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  fiscal_code text,
  billing_email text not null,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.membership_role not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id),
  candidate_name text not null,
  office_sought text not null,
  election_name text not null,
  country_code char(2) not null default 'RO',
  region text not null,
  locality text,
  slug text not null unique,
  status public.campaign_status not null default 'draft',
  sponsor_name text,
  sponsor_identifier text,
  starts_at date,
  ends_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaign_sites (
  campaign_id uuid primary key references public.campaigns(id) on delete cascade,
  domain text unique,
  headline text,
  biography text,
  theme jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  author_user_id uuid not null references auth.users(id),
  title text not null,
  body text not null,
  status public.content_status not null default 'draft',
  channels text[] not null default '{}',
  scheduled_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.social_connections (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  provider text not null check (provider in ('facebook', 'instagram', 'tiktok', 'youtube')),
  external_account_id text not null,
  display_name text,
  encrypted_token_ref text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  connected_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (campaign_id, provider, external_account_id)
);

create table public.supporter_consents (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  email text,
  phone text,
  locality text,
  consent_purpose text not null,
  consent_text_version text not null,
  consented_at timestamptz not null,
  withdrawn_at timestamptz,
  source text not null,
  created_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create table public.compliance_documents (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  document_type text not null,
  version text not null,
  status text not null check (status in ('missing', 'pending', 'accepted', 'expired')),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (campaign_id, document_type, version)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index campaigns_organization_idx on public.campaigns(organization_id);
create index content_campaign_status_idx on public.content_items(campaign_id, status);
create index consent_campaign_created_idx on public.supporter_consents(campaign_id, created_at desc);
create index audit_campaign_created_idx on public.audit_log(campaign_id, created_at desc);

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_sites enable row level security;
alter table public.content_items enable row level security;
alter table public.social_connections enable row level security;
alter table public.supporter_consents enable row level security;
alter table public.compliance_documents enable row level security;
alter table public.audit_log enable row level security;

create function public.is_organization_member(target_organization_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.organization_members m
  where m.organization_id = target_organization_id and m.user_id = auth.uid()
) $$;

create function public.can_access_campaign(target_campaign_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.campaigns c
  where c.id = target_campaign_id and public.is_organization_member(c.organization_id)
) $$;

create policy "members read organizations" on public.organizations for select using (public.is_organization_member(id));
create policy "members read memberships" on public.organization_members for select using (public.is_organization_member(organization_id));
create policy "members read campaigns" on public.campaigns for select using (public.is_organization_member(organization_id));
create policy "members manage campaign sites" on public.campaign_sites for all using (public.can_access_campaign(campaign_id)) with check (public.can_access_campaign(campaign_id));
create policy "members manage content" on public.content_items for all using (public.can_access_campaign(campaign_id)) with check (public.can_access_campaign(campaign_id));
create policy "members manage social connections" on public.social_connections for all using (public.can_access_campaign(campaign_id)) with check (public.can_access_campaign(campaign_id));
create policy "members manage consents" on public.supporter_consents for all using (public.can_access_campaign(campaign_id)) with check (public.can_access_campaign(campaign_id));
create policy "members read compliance" on public.compliance_documents for select using (public.can_access_campaign(campaign_id));
create policy "members read audit" on public.audit_log for select using (public.is_organization_member(organization_id));
