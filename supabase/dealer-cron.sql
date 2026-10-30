-- Runs the dealer every 10 minutes. Replace PASTE-CRON-SECRET with your CRON_SECRET.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('pull-a-card-dealer') where exists (select 1 from cron.job where jobname = 'pull-a-card-dealer');
select cron.schedule(
  'pull-a-card-dealer',
  '*/10 * * * *',
  $$ select net.http_post(
       url := 'https://znhbphohxomvldyvewyj.supabase.co/functions/v1/dealer',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'PASTE-CRON-SECRET'),
       body := '{}'::jsonb
     ) $$
);
