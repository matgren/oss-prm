import { Migration } from '@mikro-orm/migrations';

export class Migration20260510210902 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "prm_agencies" add column "partnership_start_date" date null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "prm_agencies" drop column "partnership_start_date";`);
  }

}
