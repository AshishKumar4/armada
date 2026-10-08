import { recipe, sh, task } from '../../../src/index';

export const media = recipe.debian().apt('ffmpeg').size('small');

/** Video n: a 10-second 1080p test clip made with ffmpeg's lavfi sources, re-encoded to 720p H.264 as the README's
 *  `transcode` does with a URL. */
const ONE = String.raw`set -e
src=/tmp/src-$1.mp4
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=10" -f lavfi -i "sine=frequency=$((200 + $1)):duration=10" -c:v libx264 -preset veryfast -c:a aac -shortest "$src"
ffmpeg -loglevel error -y -i "$src" -vf scale=-2:720 -c:v libx264 -preset veryfast -c:a aac -f mp4 "$2"
rm -f "$src"`;

export const encode = task({
  id: 'example-encode-720p',
  recipe: media,
  output: 'bytes',
  timeout: 900,
  run: (n: number, { out }) => sh`sh -c ${ONE} sh ${String(n)} ${out}`,
});

/** The same work for videos 1 to n, one after another in one container. */
export const encodeAll = task({
  id: 'example-encode-720p-serial',
  recipe: media,
  output: 'bytes',
  timeout: 3600,
  run: (n: number, { out }) => sh`sh -c ${`for i in $(seq 1 "$1"); do sh -c '${ONE.replace(/'/gu, `'\\''`)}' sh "$i" "$2"; done`} sh ${String(n)} ${out}`,
});

/** `encode`, its answers kept a day. */
export const encodeCached = task({
  id: 'example-encode-720p-cached',
  recipe: media,
  output: 'bytes',
  timeout: 900,
  cache: { days: 1 },
  run: (n: number, { out }) => sh`sh -c ${ONE} sh ${String(n)} ${out}`,
});
