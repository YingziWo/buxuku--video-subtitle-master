import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { extractAudio } from './ffmpeg';
import translate from './translate';
import { getSrtFileName, isWin32, getExtraResourcesPath } from './utils';
import { store } from './storeManager';

async function extractAudioFromVideo(event, file, filePath, audioFile) {
  event.sender.send("taskStatusChange", file, "extractAudio", "loading");
  await extractAudio(filePath, audioFile);
  event.sender.send("taskStatusChange", file, "extractAudio", "done");
}

async function generateSubtitle(event, file, audioFile, srtFile, formData, hasOpenAiWhisper) {
  const { model, sourceLanguage } = formData;
  const userPath = app.getPath("userData");
  const whisperPath = path.join(userPath, "whisper.cpp/");
  const whisperModel = model?.toLowerCase();
  const modelPath = `${whisperPath}models/ggml-${whisperModel}.bin`;

  let mainPath = `${whisperPath}main`;
  if (isWin32()) {
    mainPath = path.join(getExtraResourcesPath(), "whisper-bin-x64", "main.exe");
  }

  const settings = store.get('settings');
  const useLocalWhisper = settings?.useLocalWhisper;
  const whisperCommand = settings?.whisperCommand;
  const builtinWhisperCommand = settings?.builtinWhisperCommand;

  let runShell;
  if (hasOpenAiWhisper && useLocalWhisper && whisperCommand) {
    // 使用用户自定义的本地 Whisper 命令
    runShell = whisperCommand
      .replace(/\${audioFile}/g, audioFile)
      .replace(/\${whisperModel}/g, whisperModel)
      .replace(/\${srtFile}/g, srtFile)
      .replace(/\${sourceLanguage}/g, sourceLanguage || 'auto')
      .replace(/\${outputDir}/g, path.dirname(srtFile));
  } else {
    // 使用内置的 Whisper 命令
    runShell = (builtinWhisperCommand || '"${mainPath}" -m "${modelPath}" -f "${audioFile}" -osrt -of "${srtFile}" -l ${sourceLanguage}')
      .replace(/\${mainPath}/g, mainPath)
      .replace(/\${modelPath}/g, modelPath)
      .replace(/\${audioFile}/g, audioFile)
      .replace(/\${srtFile}/g, srtFile)
      .replace(/\${sourceLanguage}/g, sourceLanguage);
  }

  // 确保路径被正确引用
  runShell = runShell.replace(/("[^"]*")|(\S+)/g, (match, quoted, unquoted) => {
    if (quoted) return quoted;
    if (unquoted && (unquoted.includes('/') || unquoted.includes('\\'))) {
      return `"${unquoted}"`;
    }
    return unquoted || match;
  });
  console.log(runShell, 'runShell');
  event.sender.send("taskStatusChange", file, "extractSubtitle", "loading");
  
  await new Promise((resolve, reject) => {
    exec(runShell, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      event.sender.send("taskStatusChange", file, "extractSubtitle", "done");
      resolve(1);
    });
  });

  return `${srtFile}.srt`;
}

async function translateSubtitle(event, file, directory, fileName, srtFile, formData, provider) {
  event.sender.send("taskStatusChange", file, "translateSubtitle", "loading");
  await translate(event, directory, fileName, srtFile, formData, provider);
  event.sender.send("taskStatusChange", file, "translateSubtitle", "done");
}

export async function processFile(event, file, formData, hasOpenAiWhisper, provider) {
  const { sourceLanguage, targetLanguage, sourceSrtSaveOption, customSourceSrtFileName, translateProvider } = formData || {};

  try {
    const { filePath } = file;
    let directory = path.dirname(filePath);
    let fileName = path.basename(filePath, path.extname(filePath));
    const fileExtension = path.extname(filePath).toLowerCase();

    const isSubtitleFile = ['.srt', '.vtt', '.ass', '.ssa'].includes(fileExtension);
    let srtFile = filePath;

    if (!isSubtitleFile) {
      const audioFile = path.join(directory, `${fileName}_temp.wav`);
      const templateData = { fileName, sourceLanguage, targetLanguage };
      
      const sourceSrtFileName = getSrtFileName(
        sourceSrtSaveOption,
        fileName,
        sourceLanguage,
        customSourceSrtFileName,
        templateData
      );
      
      srtFile = path.join(directory, `${sourceSrtFileName}`);

      await extractAudioFromVideo(event, file, filePath, audioFile);
      srtFile = await generateSubtitle(event, file, audioFile, `${srtFile}`, formData, hasOpenAiWhisper);
      fs.unlink(audioFile, (err) => {
        if (err) console.log(err);
      });
    } else {
      // 如果是字幕文件，可能需要进行格式转换
      event.sender.send("taskStatusChange", file, "prepareSubtitle", "loading");
      // 这里可以添加字幕格式转换的逻辑，如果需要的话
      event.sender.send("taskStatusChange", file, "prepareSubtitle", "done");
    }

    if (translateProvider !== "-1") {
      await translateSubtitle(event, file, directory, fileName, srtFile, formData, provider);
    }

    // 清理临时文件
    if (!isSubtitleFile && sourceSrtSaveOption === 'noSave') {
      fs.unlink(srtFile, (err) => {
        if (err) console.log(err);
      });
    }
  } catch (error) {
    event.sender.send("message", error);
  }
}