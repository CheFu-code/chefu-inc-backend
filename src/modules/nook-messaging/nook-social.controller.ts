import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { NookSocialService } from './nook-social.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('nook')
@UseGuards(AuthGuard)
export class NookSocialController {
  constructor(private readonly social: NookSocialService) {}

  @Get('profile')
  profile(@Req() request: AuthenticatedRequest) {
    return this.social.profile(request.user);
  }

  @Post('profiles')
  createProfile(@Req() request: AuthenticatedRequest, @Body() body: { username?: string }) {
    return this.social.createProfile(request.user, body);
  }

  @Patch('profile')
  updateProfile(@Req() request: AuthenticatedRequest, @Body() body: { username?: string }) {
    return this.social.updateProfile(request.user, body);
  }

  @Get('profiles')
  searchProfiles(
    @Req() request: AuthenticatedRequest,
    @Query('q') query = '',
    @Query('page') page = '0',
    @Query('limit') limit = '20',
    @Query('cursorMode') cursorMode = 'false',
    @Query('cursor') cursor?: string,
  ) {
    if (cursorMode === 'true') {
      return this.social.searchProfilesCursor(request.user, query, cursor, Number(limit));
    }
    return this.social.searchProfiles(request.user, query, Number(page), Number(limit));
  }

  @Get('profiles/:id')
  getProfile(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.getProfile(request.user, id);
  }

  @Get('profiles/:id/connections')
  connections(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('kind') kind: 'followers' | 'following',
    @Query('page') page = '0',
    @Query('limit') limit = '20',
  ) {
    return this.social.connections(request.user, id, kind, Number(page), Number(limit));
  }

  @Post('profiles/:id/follow')
  follow(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { following?: boolean }) {
    return this.social.setFollow(request.user, id, body.following === true);
  }

  @Get('posts')
  listPosts(
    @Req() request: AuthenticatedRequest,
    @Query('feed') feed: 'home' | 'explore' | 'profile' = 'explore',
    @Query('profileId') profileId?: string,
    @Query('page') page = '0',
    @Query('limit') limit = '20',
    @Query('cursorMode') cursorMode = 'false',
    @Query('cursor') cursor?: string,
    @Query('q') query = '',
  ) {
    if (feed === 'explore' && cursorMode === 'true') {
      return this.social.searchExplorePosts(request.user, query, cursor, Number(limit));
    }
    return this.social.listPosts(request.user, feed, profileId, Number(page), Number(limit));
  }

  @Get('posts/saved')
  savedPosts(
    @Req() request: AuthenticatedRequest,
    @Query('page') page = '0',
    @Query('limit') limit = '20',
  ) {
    return this.social.listBookmarkedPosts(request.user, Number(page), Number(limit));
  }

  @Get('posts/:id')
  getPost(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.getPost(request.user, id);
  }

  @Post('posts/:id/like')
  likePost(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { liked?: boolean }) {
    return this.social.setPostLike(request.user, id, body.liked === true);
  }

  @Post('posts/:id/bookmark')
  bookmark(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { saved?: boolean }) {
    return this.social.setBookmark(request.user, id, body.saved === true);
  }

  @Get('posts/:id/bookmark')
  isBookmarked(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.isBookmarked(request.user, id);
  }

  @Delete('posts/:id')
  deletePost(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.deletePost(request.user, id);
  }

  @Get('posts/:id/comments')
  comments(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('order') order: 'asc' | 'desc' = 'desc',
    @Query('page') page = '0',
    @Query('limit') limit = '20',
  ) {
    return this.social.comments(request.user, id, order, Number(page), Number(limit));
  }

  @Post('posts/:id/comments')
  addComment(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { text?: string; requestId?: string; parentId?: string }) {
    return this.social.addComment(request.user, id, body);
  }

  @Patch('posts/:postId/comments/:commentId')
  editComment(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
    @Body() body: { text?: string },
  ) {
    return this.social.editComment(request.user, postId, commentId, body);
  }

  @Delete('posts/:postId/comments/:commentId')
  deleteComment(@Req() request: AuthenticatedRequest, @Param('postId') postId: string, @Param('commentId') commentId: string) {
    return this.social.deleteComment(request.user, postId, commentId);
  }

  @Post('posts/:postId/comments/:commentId/like')
  likeComment(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
    @Body() body: { liked?: boolean },
  ) {
    return this.social.setCommentLike(request.user, postId, commentId, body.liked === true);
  }

  @Get('stories')
  stories(@Req() request: AuthenticatedRequest) {
    return this.social.listStories(request.user);
  }

  @Post('presence-token')
  presenceToken(@Req() request: AuthenticatedRequest) {
    return this.social.createPresenceToken(request.user);
  }

  @Post('stories/:id/view')
  viewStory(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.recordStoryView(request.user, id);
  }

  @Delete('stories/:id')
  deleteStory(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.deleteStory(request.user, id);
  }

  @Post('uploads')
  createUpload(@Req() request: AuthenticatedRequest, @Body() body: {
    purpose?: 'post' | 'story';
    kind?: 'image' | 'video';
    width?: number;
    height?: number;
    duration?: number;
  }) {
    return this.social.createUpload(request.user, body);
  }

  @Post('uploads/:id/file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  uploadFile(@Req() request: AuthenticatedRequest, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Upload file is required.');
    return this.social.saveUpload(request.user, id, file.buffer, file.mimetype);
  }

  @Delete('uploads/:id')
  cancelUpload(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.cancelUpload(request.user, id);
  }

  @Post('posts')
  publishPost(@Req() request: AuthenticatedRequest, @Body() body: { uploadId?: string; caption?: string; requestId?: string }) {
    return this.social.publishPost(request.user, body);
  }

  @Post('stories')
  publishStory(@Req() request: AuthenticatedRequest, @Body() body: { uploadId?: string; caption?: string }) {
    return this.social.publishStory(request.user, body);
  }

  @Get('media/:kind/:id')
  media(@Req() request: AuthenticatedRequest, @Param('kind') kind: string, @Param('id') id: string) {
    return this.social.mediaUrl(request.user, kind, id);
  }

  @Get('conversations')
  conversations(
    @Req() request: AuthenticatedRequest,
    @Query('unreadOnly') unreadOnly = 'false',
    @Query('page') page = '0',
    @Query('limit') limit = '20',
  ) {
    return this.social.listConversations(request.user, unreadOnly === 'true', Number(page), Number(limit));
  }

  @Post('conversations')
  startConversation(@Req() request: AuthenticatedRequest, @Body() body: { profileId?: string }) {
    return this.social.startConversation(request.user, String(body.profileId || ''));
  }

  @Post('conversations/:id/request')
  respondToConversationRequest(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { decision?: 'accepted' | 'declined' },
  ) {
    if (body.decision !== 'accepted' && body.decision !== 'declined') {
      throw new BadRequestException('Choose whether to accept or decline the message request.');
    }
    return this.social.respondToConversationRequest(request.user, id, body.decision);
  }

  @Get('conversations/:id')
  getConversation(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.social.getConversation(request.user, id);
  }

  @Get('conversations/:id/messages')
  messages(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query('page') page = '0',
    @Query('limit') limit = '30',
  ) {
    return this.social.listMessages(request.user, id, Number(page), Number(limit));
  }

  @Post('conversations/:id/read')
  markRead(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: { throughSequence?: number }) {
    return this.social.markRead(request.user, id, Number(body.throughSequence || 0));
  }
}
