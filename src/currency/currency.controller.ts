import { Body, Controller, Get, Post } from "@nestjs/common";
import { CurrencyRegistryService } from "./currency-registry.service";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { registerCurrencySchema } from "./dto";
import type { RegisterCurrencyDto } from "./dto";

@Controller('currencies')
export class CurrencyController {
  constructor(private readonly service: CurrencyRegistryService){}

  @Get()
  list(){
    return this.service.list();
  }

  @Post()
  register(@Body(new ZodValidationPipe(registerCurrencySchema)) body: RegisterCurrencyDto){
    return this.service.register(body);
  }
}