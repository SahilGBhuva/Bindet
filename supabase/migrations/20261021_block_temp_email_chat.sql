-- Temporary-email accounts can't use group chat directly through Supabase either.
-- The backend already refuses them on every route (backend/disposable_email.py); chat
-- messages, read state, typing and chat images go to Supabase straight from the browser,
-- so the same block is added here as RESTRICTIVE policies. Optional, safe to re-run,
-- nothing is deleted. The domain list mirrors backend/disposable_email.py (a test checks).

create table if not exists public.blocked_email_domains (domain text primary key);
alter table public.blocked_email_domains enable row level security;
revoke all on public.blocked_email_domains from anon, authenticated;

insert into public.blocked_email_domains (domain) values
  ('027168.com'),
  ('10mail.org'),
  ('10minemail.com'),
  ('10minutemail.co.uk'),
  ('10minutemail.com'),
  ('10minutemail.de'),
  ('10minutemail.net'),
  ('10minutemail.org'),
  ('10minutesmail.com'),
  ('1secmail.com'),
  ('1secmail.net'),
  ('1secmail.org'),
  ('20minutemail.com'),
  ('20minutemail.it'),
  ('30minutemail.com'),
  ('33mail.com'),
  ('anonbox.net'),
  ('anonymbox.com'),
  ('armyspy.com'),
  ('bugfoo.com'),
  ('burnermail.io'),
  ('byom.de'),
  ('cetnob.com'),
  ('chacuo.net'),
  ('cuvox.de'),
  ('dayrep.com'),
  ('deadaddress.com'),
  ('discard.email'),
  ('discardmail.com'),
  ('discardmail.de'),
  ('disposable.email'),
  ('disposableemailaddresses.com'),
  ('disposableinbox.com'),
  ('dispostable.com'),
  ('dropmail.me'),
  ('einrot.com'),
  ('email-fake.com'),
  ('emailfake.com'),
  ('emailnax.com'),
  ('emailondeck.com'),
  ('emailtemporanea.com'),
  ('emailtemporanea.net'),
  ('emltmp.com'),
  ('ezztt.com'),
  ('fakeinbox.com'),
  ('fakemail.net'),
  ('fakemailgenerator.com'),
  ('fleckens.hu'),
  ('getairmail.com'),
  ('getnada.com'),
  ('gishpuppy.com'),
  ('grr.la'),
  ('guerrillamail.biz'),
  ('guerrillamail.com'),
  ('guerrillamail.de'),
  ('guerrillamail.info'),
  ('guerrillamail.net'),
  ('guerrillamail.org'),
  ('guerrillamailblock.com'),
  ('gustr.com'),
  ('harakirimail.com'),
  ('hexi.pics'),
  ('hide.biz.st'),
  ('inboxbear.com'),
  ('inboxkitten.com'),
  ('incognitomail.org'),
  ('jetable.org'),
  ('jourrapide.com'),
  ('kloap.com'),
  ('kurzepost.de'),
  ('linshiyouxiang.net'),
  ('luxusmail.org'),
  ('mail-temp.com'),
  ('mail.tm'),
  ('mail7.io'),
  ('mailcatch.com'),
  ('maildrop.cc'),
  ('mailexpire.com'),
  ('mailforspam.com'),
  ('mailinator.com'),
  ('mailinator.net'),
  ('mailinator.org'),
  ('mailinator2.com'),
  ('mailnesia.com'),
  ('mailnull.com'),
  ('mailpoof.com'),
  ('mailsac.com'),
  ('mailslurp.com'),
  ('mailtemp.net'),
  ('meltmail.com'),
  ('mintemail.com'),
  ('moakt.com'),
  ('mohmal.com'),
  ('mt2015.com'),
  ('mvrht.com'),
  ('mytemp.email'),
  ('mytrashmail.com'),
  ('nada.email'),
  ('nwytg.net'),
  ('one-time.email'),
  ('oneoffemail.com'),
  ('owlymail.com'),
  ('pokemail.net'),
  ('rhyta.com'),
  ('rootfest.net'),
  ('sharklasers.com'),
  ('shitmail.me'),
  ('smashmail.de'),
  ('snapmail.cc'),
  ('spam4.me'),
  ('spambog.com'),
  ('spambox.us'),
  ('spamex.com'),
  ('spamfree24.org'),
  ('spamgourmet.com'),
  ('spaml.com'),
  ('spamspot.com'),
  ('superrito.com'),
  ('teleworm.us'),
  ('temp-mail.io'),
  ('temp-mail.org'),
  ('temp-mail.ru'),
  ('tempail.com'),
  ('tempemail.co'),
  ('tempemail.com'),
  ('tempemail.net'),
  ('tempinbox.com'),
  ('tempm.com'),
  ('tempmail.com'),
  ('tempmail.de'),
  ('tempmail.dev'),
  ('tempmail.net'),
  ('tempmail.plus'),
  ('tempmailaddress.com'),
  ('tempmailo.com'),
  ('temporaryemail.net'),
  ('temporaryinbox.com'),
  ('tempr.email'),
  ('thankyou2010.com'),
  ('throwam.com'),
  ('throwawaymail.com'),
  ('tmail.ws'),
  ('tmailor.com'),
  ('tmails.net'),
  ('tmpbox.net'),
  ('tmpmail.net'),
  ('tmpmail.org'),
  ('trash-mail.com'),
  ('trashmail.at'),
  ('trashmail.com'),
  ('trashmail.de'),
  ('trashmail.io'),
  ('trashmail.me'),
  ('trashmail.net'),
  ('trashmail.ws'),
  ('trbvm.com'),
  ('vintomaper.com'),
  ('vomoto.com'),
  ('wegwerfmail.de'),
  ('wegwerfmail.net'),
  ('wegwerfmail.org'),
  ('wireconnected.com'),
  ('yomail.info'),
  ('yopmail.com'),
  ('yopmail.fr'),
  ('yopmail.net'),
  ('zetmail.com'),
  ('zippymail.info')
on conflict (domain) do nothing;

-- True when the signed-in account's email is at a blocked domain (or a subdomain of one).
create or replace function public.email_is_disposable()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.blocked_email_domains d
    where split_part(lower(coalesce(auth.jwt() ->> 'email', '')), '@', 2) = d.domain
       or split_part(lower(coalesce(auth.jwt() ->> 'email', '')), '@', 2) like '%.' || d.domain
  );
$$;
revoke execute on function public.email_is_disposable() from public, anon;
grant execute on function public.email_is_disposable() to authenticated;

do $$
declare
  target text;
begin
  foreach target in array array['study_group_messages', 'study_group_chat_reads', 'study_group_chat_typing'] loop
    if to_regclass('public.' || target) is not null
       and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = target
                       and policyname = 'No temporary-email accounts') then
      execute format(
        'create policy "No temporary-email accounts" on public.%I as restrictive for all to authenticated '
        'using (not public.email_is_disposable()) with check (not public.email_is_disposable())', target);
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                 and policyname = 'No temporary-email accounts in chat images') then
    create policy "No temporary-email accounts in chat images" on storage.objects
      as restrictive for all to authenticated
      using (bucket_id <> 'study-group-images' or not public.email_is_disposable())
      with check (bucket_id <> 'study-group-images' or not public.email_is_disposable());
  end if;
end $$;
