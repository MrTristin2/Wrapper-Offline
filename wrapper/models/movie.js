const fs = require("fs");
const nodezip = require("node-zip");
const path = require("path");
const database = require("../../data/database"), DB = new database();
const fUtil = require("../../utils/fileUtil");
const Parse = require("../models/parse");
const folder = path.join(__dirname, "../../", process.env.SAVED_FOLDER);
const base = Buffer.alloc(1, 0);

module.exports = {
	/**
	 * deletes a movie do i really have to explain this to you
	 * @param {string} id 
	 */
	delete(id) {
		DB.delete("movies", id);
		DB.delete("assets", id);

		// delete the actual file
		fs.unlinkSync(path.join(folder, `${id}.xml`));
		fs.unlinkSync(path.join(folder, `${id}.png`));
	},

	/**
	 * Parses a saved movie for the LVM.
	 * @param {string} mId 
	 * @param {boolean} isGet 
	 * @returns {Promise<Buffer>}
	 */
	async load(mId, isGet = true) {
		const filepath = path.join(folder, `${mId}.xml`);

		const buffer = fs.readFileSync(filepath);
		const thumbBuffer = fs.readFileSync(filepath.slice(0, -3) + "png");
		const parsed = await Parse.pack(buffer, thumbBuffer);
		return isGet ? parsed : Buffer.concat([base, parsed]);
	},

	/**
	 * @param {string} id 
	 * @returns {Promise<{
	 *  filepath: string,
	 *  start: number,
	 *  stop: number,
	 *  trimStart: number,
	 *  trimEnd: number,
	 *  fadeIn: {
	 *   duration: number;
	 *   vol: number;
	 *  },
	 *  fadeOut: {
	 *   duration: number;
	 *   vol: number;
	 *  }
	 * }[]>}
	 */
	async getAudio(id) {
		const filepath = path.join(folder, `${id}.xml`);
		const xml = fs.readFileSync(filepath);
		const audio = await Parse.extractAudioTimes(xml);
		return audio;
	},

	/**
	 * Gets movie metadata from an XML.
	 * @param {string} id the movie id
	 * @returns {{
	 * 	date: Date,
	 *  durationString: string,
	 * 	duration: number,
	 *  sceneCount?: count,
	 * 	title: string,
	 * 	id: string
	 * }} 
	 */
	async meta(id) {
		const filepath = path.join(folder, `${id}.xml`);
		const buffer = fs.readFileSync(filepath);

		// title
		const title = buffer.subarray(
			buffer.indexOf("<title>") + 16,
			buffer.indexOf("]]></title>")
		).toString().trim();

		// get the duration string
		const durBeg = buffer.indexOf('duration="') + 10;
		const duration = Number.parseFloat(buffer.subarray(
			durBeg,
			buffer.indexOf('"', durBeg)
		).toString().trim());
		const min = ('' + ~~(duration / 60)).padStart(2, '0');
		const sec = ('' + ~~(duration % 60)).padStart(2, '0');
		const durationStr = `${min}:${sec}`;

		let count = 0;
		let pos = buffer.indexOf('<scene id=');
		while (pos > -1) {
			count++;
			pos = buffer.indexOf('<scene id=', pos + 10);
		}

		return {
			id,
			duration,
			title,
			date: fs.statSync(filepath).mtime,
			durationString: durationStr,
			sceneCount: count,
		};
	},

	/**
	 * Extracts the movie XML from a zip and saves it.
	 * @param {Buffer} body the movie xml
	 * @param {Buffer} thumb movie thumbnail in .png format
	 * @param {string} mId movie id, if overwriting an old one
	 * @param {boolean} starter is it a starter
	 * @returns {Promise<string>}
	 */
	async save(body, thumb, id, starter) {
		return new Promise((resolve, reject) => {
			id ||= fUtil.generateId();

			// save the thumbnail on manual saves
			if (thumb) {
				fs.writeFileSync(path.join(folder, `${id}.png`), thumb);
			}
			// extract the movie xml and save it
			const zip = nodezip.unzip(body);
			const xmlStream = zip["movie.xml"].toReadStream();

			let writeStream = fs.createWriteStream(path.join(folder, `${id}.xml`));
			xmlStream.on("data", b => writeStream.write(b));
			xmlStream.on("end", async () => {
				writeStream.close((e) => {
					if (e) throw e;

					this.meta(id).then((meta) => {
						let type;
						const info = {
							id,
							duration: meta.durationString,
							date: meta.date,
							title: meta.title,
							sceneCount: meta.sceneCount,
						}
						if (starter) {
							info.type = "movie";
							type = "assets";
						} else {
							type = "movies";
						}

						if (!DB.update(type, id, info)) {
							console.log("This movie does not exist in the database. Inserting...", e);
							DB.insert(type, info);
						}
						resolve(id);
					});
				});
			});
		});
	},

	/**
	 * Returns a stream of a movie thumbnail.
	 * @param {string} id 
	 * @returns {fs.readStream}
	 */
	thumb(id) {
		// look for match in folder
		const filepath = path.join(folder, `${id}.png`);
		if (fs.existsSync(filepath)) {
			const readStream = fs.createReadStream(filepath);
			return readStream;
		} else {
			throw new Error("Movie doesn't exist.");
		}
	},

	/**
	 * unpacks a movie zip
	 * @param {Buffer} body zip containing the movie and its assets
	 * @returns {Promise<string>}
	 */
	upload(body, isStarter) {
		return new Promise(async (res, rej) => {
			const id = fUtil.generateId();
			const [xml, thumb] = await Parse.unpack(body);

			fs.writeFileSync(path.join(folder, `${id}.xml`), xml);
			fs.writeFileSync(path.join(folder, `${id}.png`), thumb);
			this.meta(id).then((meta) => {
				let type;
				const info = {
					id,
					duration: meta.durationString,
					date: meta.date,
					title: meta.title,
					sceneCount: meta.sceneCount,
				}
				if (isStarter) {
					info.type = "movie";
					type = "assets";
				} else {
					type = "movies";
				}

				DB.insert(type, info);
				res(id);
			});
		});
	}
};
