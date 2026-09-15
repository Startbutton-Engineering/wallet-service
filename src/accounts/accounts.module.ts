import { Global, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AccountsRepository } from "./accounts.repository";
import { Account, AccountSchema } from "./account.schema";

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: Account.name, schema: AccountSchema }])],
  providers: [AccountsRepository],
  exports: [AccountsRepository, MongooseModule]
})
export class AccountsModule {}
