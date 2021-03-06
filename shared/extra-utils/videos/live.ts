/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import { expect } from 'chai'
import * as ffmpeg from 'fluent-ffmpeg'
import { pathExists, readdir } from 'fs-extra'
import { omit } from 'lodash'
import { join } from 'path'
import { LiveVideo, LiveVideoCreate, LiveVideoUpdate, VideoDetails, VideoState } from '@shared/models'
import { buildAbsoluteFixturePath, buildServerDirectory, wait } from '../miscs/miscs'
import { makeGetRequest, makePutBodyRequest, makeUploadRequest } from '../requests/requests'
import { ServerInfo } from '../server/servers'
import { getVideoWithToken } from './videos'

function getLive (url: string, token: string, videoId: number | string, statusCodeExpected = 200) {
  const path = '/api/v1/videos/live'

  return makeGetRequest({
    url,
    token,
    path: path + '/' + videoId,
    statusCodeExpected
  })
}

function updateLive (url: string, token: string, videoId: number | string, fields: LiveVideoUpdate, statusCodeExpected = 204) {
  const path = '/api/v1/videos/live'

  return makePutBodyRequest({
    url,
    token,
    path: path + '/' + videoId,
    fields,
    statusCodeExpected
  })
}

function createLive (url: string, token: string, fields: LiveVideoCreate, statusCodeExpected = 200) {
  const path = '/api/v1/videos/live'

  const attaches: any = {}
  if (fields.thumbnailfile) attaches.thumbnailfile = fields.thumbnailfile
  if (fields.previewfile) attaches.previewfile = fields.previewfile

  const updatedFields = omit(fields, 'thumbnailfile', 'previewfile')

  return makeUploadRequest({
    url,
    path,
    token,
    attaches,
    fields: updatedFields,
    statusCodeExpected
  })
}

async function sendRTMPStreamInVideo (url: string, token: string, videoId: number | string) {
  const res = await getLive(url, token, videoId)
  const videoLive = res.body as LiveVideo

  return sendRTMPStream(videoLive.rtmpUrl, videoLive.streamKey)
}

function sendRTMPStream (rtmpBaseUrl: string, streamKey: string) {
  const fixture = buildAbsoluteFixturePath('video_short.mp4')

  const command = ffmpeg(fixture)
  command.inputOption('-stream_loop -1')
  command.inputOption('-re')
  command.outputOption('-c:v libx264')
  command.outputOption('-g 50')
  command.outputOption('-keyint_min 2')
  command.outputOption('-f flv')

  const rtmpUrl = rtmpBaseUrl + '/' + streamKey
  command.output(rtmpUrl)

  command.on('error', err => {
    if (err?.message?.includes('Exiting normally')) return

    if (process.env.DEBUG) console.error(err)
  })

  if (process.env.DEBUG) {
    command.on('stderr', data => console.log(data))
  }

  command.run()

  return command
}

function waitFfmpegUntilError (command: ffmpeg.FfmpegCommand, successAfterMS = 10000) {
  return new Promise((res, rej) => {
    command.on('error', err => {
      return rej(err)
    })

    setTimeout(() => {
      res()
    }, successAfterMS)
  })
}

async function runAndTestFfmpegStreamError (url: string, token: string, videoId: number | string, shouldHaveError: boolean) {
  const command = await sendRTMPStreamInVideo(url, token, videoId)

  return testFfmpegStreamError(command, shouldHaveError)
}

async function testFfmpegStreamError (command: ffmpeg.FfmpegCommand, shouldHaveError: boolean) {
  let error: Error

  try {
    await waitFfmpegUntilError(command, 15000)
  } catch (err) {
    error = err
  }

  await stopFfmpeg(command)

  if (shouldHaveError && !error) throw new Error('Ffmpeg did not have an error')
  if (!shouldHaveError && error) throw error
}

async function stopFfmpeg (command: ffmpeg.FfmpegCommand) {
  command.kill('SIGINT')

  await wait(500)
}

async function waitUntilLiveStarts (url: string, token: string, videoId: number | string) {
  let video: VideoDetails

  do {
    const res = await getVideoWithToken(url, token, videoId)
    video = res.body

    await wait(500)
  } while (video.state.id === VideoState.WAITING_FOR_LIVE)
}

async function checkLiveCleanup (server: ServerInfo, videoUUID: string, resolutions: number[] = []) {
  const basePath = buildServerDirectory(server.internalServerNumber, 'streaming-playlists')
  const hlsPath = join(basePath, 'hls', videoUUID)

  if (resolutions.length === 0) {
    const result = await pathExists(hlsPath)
    expect(result).to.be.false

    return
  }

  const files = await readdir(hlsPath)

  // fragmented file and playlist per resolution + master playlist + segments sha256 json file
  expect(files).to.have.lengthOf(resolutions.length * 2 + 2)

  for (const resolution of resolutions) {
    expect(files).to.contain(`${videoUUID}-${resolution}-fragmented.mp4`)
    expect(files).to.contain(`${resolution}.m3u8`)
  }

  expect(files).to.contain('master.m3u8')
  expect(files).to.contain('segments-sha256.json')
}

// ---------------------------------------------------------------------------

export {
  getLive,
  updateLive,
  waitUntilLiveStarts,
  createLive,
  runAndTestFfmpegStreamError,
  checkLiveCleanup,
  stopFfmpeg,
  sendRTMPStreamInVideo,
  waitFfmpegUntilError,
  sendRTMPStream,
  testFfmpegStreamError
}
