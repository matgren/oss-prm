import { Migration } from '@mikro-orm/migrations';

export class Migration20260505090240 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "example_customer_interaction_mappings" add column if not exists "deleted_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "example_customer_interaction_mappings" drop column if exists "deleted_at";`);
  }

}
