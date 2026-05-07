import { Migration } from '@mikro-orm/migrations';

export class Migration20260507062644 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "prm_agencies" add column "version" int not null default 1;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "prm_agencies" drop column "version";`);
  }

}
