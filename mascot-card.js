import * as THREE from "./assets/vendor/three.module.js";

const stage = document.querySelector(".mascot-stage");
const canvas = document.querySelector("#mascot-canvas");

if (stage && canvas && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0, 7.4);

    const group = new THREE.Group();
    scene.add(group);

    const texture = new THREE.TextureLoader().load(
      "assets/blarc-mascot.jpg",
      () => stage.classList.add("is-3d-ready"),
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const sideMaterial = new THREE.MeshStandardMaterial({ color: 0x14344a, metalness: 0.72, roughness: 0.28 });
    const backMaterial = new THREE.MeshStandardMaterial({ color: 0x07141d, metalness: 0.8, roughness: 0.3 });
    const faceMaterial = new THREE.MeshStandardMaterial({ map: texture, metalness: 0.05, roughness: 0.58 });
    const card = new THREE.Mesh(
      new THREE.BoxGeometry(3.75, 3.75, 0.16, 1, 1, 1),
      [sideMaterial, sideMaterial, sideMaterial, sideMaterial, faceMaterial, backMaterial],
    );
    group.add(card);

    const edgeGeometry = new THREE.EdgesGeometry(card.geometry);
    const edges = new THREE.LineSegments(
      edgeGeometry,
      new THREE.LineBasicMaterial({ color: 0x8ee9ff, transparent: true, opacity: 0.72 }),
    );
    edges.scale.setScalar(1.006);
    card.add(edges);

    scene.add(new THREE.HemisphereLight(0xd9f5ff, 0x071018, 2.1));
    const key = new THREE.DirectionalLight(0x47b8ff, 4.2);
    key.position.set(3, 4, 5);
    scene.add(key);
    const rim = new THREE.PointLight(0x65e1ff, 7, 12);
    rim.position.set(-3.5, -1, 3);
    scene.add(rim);

    let pointerX = 0;
    let pointerY = 0;
    let visible = true;

    stage.addEventListener("pointermove", (event) => {
      const rect = stage.getBoundingClientRect();
      pointerX = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      pointerY = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    });
    stage.addEventListener("pointerleave", () => {
      pointerX = 0;
      pointerY = 0;
    });

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    observer.observe(stage);

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
      group.rotation.y += (pointerX * 0.16 - group.rotation.y) * 0.045;
      group.rotation.x += (-pointerY * 0.12 - group.rotation.x) * 0.045;
      group.position.y = Math.sin(time * 0.72) * 0.08 + 0.28;
      card.rotation.z = Math.sin(time * 0.42) * 0.012;
      renderer.render(scene, camera);
    };
    render();
  } catch {
    stage.classList.remove("is-3d-ready");
  }
}
