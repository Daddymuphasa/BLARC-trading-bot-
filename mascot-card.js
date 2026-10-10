import * as THREE from "./assets/vendor/three.module.js";

const stage = document.querySelector(".mascot-stage");
const canvas = document.querySelector("#mascot-canvas");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (stage && canvas && !reduceMotion) {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 100);
    camera.position.set(0, 0.1, 9.6);
    const box = new THREE.Group();
    box.position.y = 0.35;
    scene.add(box);

    const shellMaterial = new THREE.MeshStandardMaterial({ color: 0x0b2637, metalness: 0.82, roughness: 0.24 });
    const innerMaterial = new THREE.MeshStandardMaterial({ color: 0x06131c, metalness: 0.3, roughness: 0.62 });
    const cyanMaterial = new THREE.MeshStandardMaterial({
      color: 0x65e1ff,
      emissive: 0x0d6d86,
      emissiveIntensity: 1.4,
      metalness: 0.65,
      roughness: 0.2,
    });

    const addPart = (width, height, depth, x, y, z, material = shellMaterial) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
      mesh.position.set(x, y, z);
      box.add(mesh);
      return mesh;
    };

    addPart(4.8, 5.7, 0.28, 0, 0, -0.52, innerMaterial);
    addPart(0.3, 5.9, 0.86, -2.42, 0, -0.08);
    addPart(0.3, 5.9, 0.86, 2.42, 0, -0.08);
    addPart(5.14, 0.3, 0.86, 0, 2.96, -0.08);
    addPart(5.14, 0.5, 0.92, 0, -2.86, -0.05);
    addPart(4.5, 0.055, 0.16, 0, 2.56, 0.35, cyanMaterial);
    addPart(4.5, 0.055, 0.16, 0, -2.48, 0.35, cyanMaterial);
    addPart(3.9, 0.12, 0.72, 0, -2.18, -0.02);

    const texture = new THREE.TextureLoader().load("assets/blarc-mascot.jpg", () => {
      stage.classList.add("is-3d-ready");
    });
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const mascot = new THREE.Mesh(
      new THREE.PlaneGeometry(4.1, 4.1),
      new THREE.MeshStandardMaterial({ map: texture, metalness: 0.02, roughness: 0.72 }),
    );
    mascot.position.set(0, 0.2, 0.02);
    box.add(mascot);

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(4.72, 5.52, 0.045),
      new THREE.MeshPhysicalMaterial({
        color: 0xb9f4ff,
        transparent: true,
        opacity: 0.12,
        roughness: 0.08,
        metalness: 0.05,
        transmission: 0.45,
        thickness: 0.08,
      }),
    );
    glass.position.z = 0.48;
    box.add(glass);
    const glassEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(glass.geometry),
      new THREE.LineBasicMaterial({ color: 0x8ee9ff, transparent: true, opacity: 0.7 }),
    );
    glassEdges.position.copy(glass.position);
    box.add(glassEdges);

    scene.add(new THREE.HemisphereLight(0xd9f5ff, 0x02080d, 1.8));
    const key = new THREE.DirectionalLight(0x8ee9ff, 4.8);
    key.position.set(3.5, 5, 6);
    scene.add(key);
    const pointerLight = new THREE.PointLight(0x47b8ff, 12, 14);
    pointerLight.position.set(-3, 0, 4.5);
    scene.add(pointerLight);
    const lowerLight = new THREE.PointLight(0x65e1ff, 5, 10);
    lowerLight.position.set(2.4, -3.5, 2.5);
    scene.add(lowerLight);

    let pointerX = 0;
    let pointerY = 0;
    let targetScale = 1;
    let visible = true;
    const updatePointer = (event) => {
      const rect = stage.getBoundingClientRect();
      pointerX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      pointerY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      pointerLight.position.x = pointerX * 4;
      pointerLight.position.y = -pointerY * 3;
    };

    stage.addEventListener("pointermove", updatePointer);
    stage.addEventListener("pointerdown", (event) => {
      updatePointer(event);
      targetScale = 0.96;
    });
    window.addEventListener("pointerup", () => {
      targetScale = 1.035;
      window.setTimeout(() => {
        targetScale = 1;
      }, 180);
    });
    stage.addEventListener("pointerleave", () => {
      pointerX = 0;
      pointerY = 0;
      targetScale = 1;
    });
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    }).observe(stage);

    const resize = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(stage);
    resize();

    const clock = new THREE.Clock();
    const render = () => {
      requestAnimationFrame(render);
      if (!visible) return;
      const time = clock.getElapsedTime();
      box.rotation.y += (pointerX * 0.22 - box.rotation.y) * 0.055;
      box.rotation.x += (-pointerY * 0.14 - box.rotation.x) * 0.055;
      box.rotation.z = Math.sin(time * 0.45) * 0.009;
      box.position.y = 0.35 + Math.sin(time * 0.72) * 0.075;
      const nextScale = box.scale.x + (targetScale - box.scale.x) * 0.12;
      box.scale.setScalar(nextScale);
      glass.material.opacity = 0.1 + Math.max(0, pointerX) * 0.035 + Math.sin(time * 0.8) * 0.01;
      renderer.render(scene, camera);
    };
    render();
  } catch {
    stage.classList.remove("is-3d-ready");
  }
}
