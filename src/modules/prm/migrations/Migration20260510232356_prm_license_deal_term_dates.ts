import { Migration } from '@mikro-orm/migrations';

export class Migration20260510232356 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "prm_license_deals" add column "license_start_date" date null, add column "license_end_date" date null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "prm_license_deals" drop column "license_start_date", drop column "license_end_date";`);
  }

}
