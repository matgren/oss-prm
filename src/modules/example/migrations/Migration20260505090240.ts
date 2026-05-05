import { Migration } from '@mikro-orm/migrations';

export class Migration20260505090240 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "example_customer_priorities" ("id" uuid not null default gen_random_uuid(), "customer_id" uuid not null, "priority" text not null default 'normal', "tenant_id" uuid not null, "organization_id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, constraint "example_customer_priorities_pkey" primary key ("id"));`);
  }

}
