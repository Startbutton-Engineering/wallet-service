import { Global, Module } from "@nestjs/common";
import { AccountsRepository } from "./accounts.repository";

@Global()
@Module({
  providers: [AccountsRepository],
  exports: [AccountsRepository]
})
export class AccountsModule {}