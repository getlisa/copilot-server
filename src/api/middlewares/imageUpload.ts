import multer from "multer";

const MAX_FILES = 4;
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

const storage = multer.memoryStorage();

const imageOnlyFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  if (!file.mimetype.startsWith("image/")) {
    const error = new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname);
    error.message = "Only image uploads are allowed";
    return cb(error);
  }
  cb(null, true);
};

export const imageUpload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: imageOnlyFilter,
});
