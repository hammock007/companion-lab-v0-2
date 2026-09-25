alter table public.companions
add column if not exists usual_sleep_start time;

alter table public.companions
add column if not exists usual_wake_time time;

update public.companions
set
  usual_sleep_start = '20:30:00',
  usual_wake_time = '05:00:00',
  updated_at = now()
where id = 'f903741d-5382-45b2-bf7a-ac63c54a978b';


alter table public.companion_heartbeats
add column if not exists deliver_after timestamptz;


-- Remove the old constraint BEFORE renaming existing decisions.
alter table public.companion_heartbeats
drop constraint if exists companion_heartbeats_decision_check;


-- Convert existing heartbeat terminology.
update public.companion_heartbeats
set decision = 'send_now'
where decision = 'send_message';


-- Install the new allowed decision set.
alter table public.companion_heartbeats
add constraint companion_heartbeats_decision_check
check (
  decision in (
    'remain_silent',
    'send_now',
    'queue_message'
  )
);