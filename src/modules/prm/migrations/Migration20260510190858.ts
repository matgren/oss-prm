import { Migration } from '@mikro-orm/migrations';

export class Migration20260510190858 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "prm_agencies" alter column "headquarters_country" type text using ("headquarters_country"::text);`);
    this.addSql(`alter table "prm_agencies" alter column "headquarters_country" drop not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "prm_agencies" alter column "headquarters_country" type text using ("headquarters_country"::text);`);
    this.addSql(`alter table "prm_agencies" alter column "headquarters_country" set not null;`);
  }

}
