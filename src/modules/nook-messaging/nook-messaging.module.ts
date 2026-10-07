import { Module } from '@nestjs/common';
import { CloudinaryStorageModule } from '../../common/cloudinary-storage.module';
import { AuthModule } from '../auth/auth.module';
import { NookMessagingController } from './nook-messaging.controller';
import { NookMessagingService } from './nook-messaging.service';
import { NookSocialController } from './nook-social.controller';
import { NookSocialService } from './nook-social.service';

@Module({
  imports: [AuthModule, CloudinaryStorageModule],
  controllers: [NookMessagingController, NookSocialController],
  providers: [NookMessagingService, NookSocialService],
})
export class NookMessagingModule {}