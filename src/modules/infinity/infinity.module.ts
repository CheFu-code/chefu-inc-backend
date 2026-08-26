import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { InfinityController } from './infinity.controller';
import { InfinityService } from './infinity.service';

@Module({
    imports: [AuthModule, FirebaseAdminModule],
    controllers: [InfinityController],
    providers: [InfinityService],
})
export class InfinityModule { }